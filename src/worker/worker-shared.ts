import { FrameCoordinator } from '../render/shared/frame-coordinator.js'
import type { RenderSchedulerClock } from '../render/shared/scheduler.js'
import { isSoftwareWebGpuAdapter } from '../render/webgpu/adapter.js'
import { DeviceOwner } from '../render/webgpu/device-owner.js'
import { readSfntFontMetrics } from '../term/font-metrics.js'
import type { TerminalFontMetrics } from '../term/types.js'
import type { WorkerFontFace } from './protocol.js'
import { workerError } from '../transport/worker-errors.js'
import { SettledPaint } from './settled-paint.js'

const fontScope = () => globalThis as unknown as FontScope

export type AdapterPolicy = 'hardware' | 'any'

interface WorkerClockScope {
  requestAnimationFrame(callback: FrameRequestCallback): number
  cancelAnimationFrame(handle: number): void
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
}

export function workerClock(scope: WorkerClockScope): RenderSchedulerClock {
  return {
    requestFrame: (callback) => scope.requestAnimationFrame(callback),
    cancelFrame: (handle) => scope.cancelAnimationFrame(handle),
    setTimer: (callback, delay) => scope.setTimeout(callback, delay),
    clearTimer: (handle) => scope.clearTimeout(handle),
  }
}

export interface SharedFontFace {
  readonly face: FontFace
  readonly metrics?: TerminalFontMetrics
  readonly loaded: Promise<FontFace>
}
interface FaceEntry extends SharedFontFace {
  readonly key: string
  readonly bytes?: Uint8Array
  users: number
}

function faceKey(source: WorkerFontFace): string {
  const origin =
    'url' in source.source ? `url:${source.source.url}` : `bytes:${source.source.bytes.byteLength}`
  return JSON.stringify([source.family, origin, source.descriptors ?? null])
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++)
    if (left[index] !== right[index]) return false
  return true
}

interface FontScope {
  readonly fonts: FontFaceSet
}

let current: WorkerShared | undefined
/** This worker's shared resources, created on first use. */
export function workerShared(): WorkerShared {
  return (current ??= new WorkerShared(workerClock(globalThis as unknown as WorkerClockScope)))
}

/** Resources every terminal in one worker shares: one paint per frame and one device per policy. */
export class WorkerShared {
  readonly frameCoordinator: FrameCoordinator
  acquiredDevices = 0
  pendingAcquisitions = 0
  private readonly owners = new Map<AdapterPolicy, DeviceOwner>()
  // One face per source: every add or delete changes the font set and retires shared glyph atlases.
  private readonly faces = new Map<string, FaceEntry[]>()
  /** Pooled terminals paint once the worker's queued output is parsed. */
  readonly settled: SettledPaint

  constructor(readonly clock: RenderSchedulerClock) {
    this.frameCoordinator = new FrameCoordinator(clock)
    this.settled = new SettledPaint(clock, (paint) => this.frameCoordinator.batch(paint))
  }

  acquireFace(source: WorkerFontFace): SharedFontFace {
    const key = faceKey(source)
    const bytes = 'bytes' in source.source ? source.source.bytes : undefined
    const entries = this.faces.get(key) ?? []
    let entry = entries.find((candidate) => !bytes || sameBytes(candidate.bytes!, bytes))
    if (!entry) {
      entry = this.createFace(source, key, bytes)
      entries.push(entry)
      this.faces.set(key, entries)
    }
    entry.users += 1
    return entry
  }

  /** Adds loaded faces in declaration order, which decides overlapping matches as before. */
  addFaces(faces: readonly SharedFontFace[]): void {
    const fonts = fontScope().fonts
    for (const shared of faces) {
      if ((shared as FaceEntry).users > 0 && !fonts.has(shared.face)) fonts.add(shared.face)
    }
  }

  releaseFace(shared: SharedFontFace): void {
    const entry = shared as FaceEntry
    entry.users -= 1
    if (entry.users > 0) return
    this.forget(entry)
    fontScope().fonts.delete(entry.face)
  }

  private createFace(
    source: WorkerFontFace,
    key: string,
    bytes: Uint8Array | undefined,
  ): FaceEntry {
    const data = bytes
      ? new Uint8Array(bytes).buffer
      : `url(${JSON.stringify((source.source as { url: string }).url)})`
    const face = new FontFace(source.family, data, source.descriptors)
    const metrics = typeof data === 'string' ? undefined : readSfntFontMetrics(new Uint8Array(data))
    const loaded = face.load()
    const entry: FaceEntry = { key, face, metrics, loaded, bytes, users: 0 }
    // A failed load stays with the terminals that saw it; later terminals load again.
    loaded.catch(() => this.forget(entry))
    return entry
  }

  private forget(entry: FaceEntry): void {
    const entries = this.faces.get(entry.key)
    if (!entries) return
    const index = entries.indexOf(entry)
    if (index >= 0) entries.splice(index, 1)
    if (entries.length === 0) this.faces.delete(entry.key)
  }

  deviceOwner(policy: AdapterPolicy): DeviceOwner {
    let owner = this.owners.get(policy)
    if (owner) return owner
    owner = new DeviceOwner(() => this.requestDevice(policy))
    this.owners.set(policy, owner)
    return owner
  }

  private async requestDevice(policy: AdapterPolicy): Promise<GPUDevice> {
    this.pendingAcquisitions += 1
    try {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) throw workerError('capability', 'renderer.webgpu', { adapter: false })
      if (policy === 'hardware' && isSoftwareWebGpuAdapter(adapter))
        throw workerError('capability', 'renderer.webgpu', { softwareAdapter: true })
      const device = await adapter.requestDevice()
      this.acquiredDevices += 1
      return device
    } finally {
      this.pendingAcquisitions -= 1
    }
  }
}
