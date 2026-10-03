import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { attachNativeTestBuilder } from './native-state.js'
import {
  qualifyDeviceReplacement,
  type DeviceReplacementQualification,
} from './adapter-qualification.js'
import { FrameObserver } from '../frame-observer.js'
import { RenderStateDirty } from '../../core/abi.js'
import { createGhosttyError } from '../../core/error.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type {
  ReadRowsOptions,
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
} from '../../core/types.js'
import type { TerminalFittedFont, TerminalFontSettings } from '../../term/types.js'
import {
  WebGpuTerminalRenderer,
  type RendererFrameSnapshot,
  type RenderStateSource,
  type WebGpuTerminalRendererOptions,
} from '../renderer.js'
import type { RenderSchedulerClock } from '../scheduler.js'

const devices = new Set<GPUDevice>()
const renderers = new Set<WebGpuTerminalRenderer>()
// Keep Dawn's external instance alive while SwiftShader churns test-owned devices.
let sentinelDevice: GPUDevice
let deviceReplacement: DeviceReplacementQualification
let deviceCleanupDelayMs = 0

beforeAll(async () => {
  const adapter = await requestAdapter()
  const info = adapter.info
  deviceReplacement = qualifyDeviceReplacement(info, navigator.userAgent)
  // Chromium's Linux SwiftShader adapter lags configured-canvas teardown.
  deviceCleanupDelayMs = deviceReplacement.kind === 'skip' ? 50 : 0
  console.info(
    'WebGPU replacement qualification',
    JSON.stringify({
      vendor: info?.vendor,
      architecture: info?.architecture,
      device: info?.device,
      description: info?.description,
      isFallbackAdapter: info?.isFallbackAdapter,
      qualification: deviceReplacement,
    }),
  )
  sentinelDevice = await adapter.requestDevice()
})

afterEach(async () => {
  for (const renderer of renderers) renderer.dispose()
  renderers.clear()
  const losses = [...devices].map((device) => device.lost)
  for (const device of devices) device.destroy()
  await Promise.all(losses)
  devices.clear()
  await waitForDeviceCleanup()
})

afterAll(async () => {
  const loss = sentinelDevice.lost
  sentinelDevice.destroy()
  await loss
})

class FakeClock implements RenderSchedulerClock {
  private nextHandle = 1
  readonly frames = new Map<number, () => void>()
  readonly timers = new Map<number, () => void>()

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }

  requestFrame(callback: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.frames.set(handle, callback)
    return handle
  }

  setTimer(callback: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.timers.set(handle, callback)
    return handle
  }

  flushFrame(): void {
    this.take(this.frames, 'frame')()
  }

  flushTimer(): void {
    this.take(this.timers, 'timer')()
  }

  private take(callbacks: Map<number, () => void>, kind: string): () => void {
    const entry = callbacks.entries().next().value
    if (!entry) throw new Error(`No pending ${kind}`)
    callbacks.delete(entry[0])
    return entry[1]
  }
}

class FakeRenderState implements RenderStateSource {
  acknowledgements = 0
  private cursor: RenderCursorSnapshot = {
    blinking: true,
    passwordInput: false,
    style: 'block',
    viewport: { wideTail: false, x: 0, y: 0 },
    visible: true,
  }
  private damage = RenderStateDirty.Full
  private readonly rows: RenderRow[]

  constructor(columns: number, rows: number) {
    this.rows = Array.from({ length: rows }, (_, y) => ({
      cells: Array.from({ length: columns }, (_, x) => fakeCell(x, y)),
      dirty: true,
      y,
    }))
  }

  acknowledge(): number {
    const dirty = this.rows.filter((row) => row.dirty).length
    for (const row of this.rows) row.dirty = false
    this.damage = RenderStateDirty.False
    this.acknowledgements += 1
    return dirty
  }

  readRows(options: ReadRowsOptions = {}): readonly RenderRow[] {
    return this.rows.filter(
      (row) => (!options.dirtyOnly || row.dirty) && (!options.rows || options.rows.has(row.y)),
    )
  }

  readCursor(): RenderCursorSnapshot {
    return {
      ...this.cursor,
      viewport: this.cursor.viewport ? { ...this.cursor.viewport } : undefined,
    }
  }

  update(): RenderStateDirty {
    return this.damage
  }

  dirtyRow(row: number): void {
    const target = this.rows[row]
    if (!target) throw new RangeError(`Unknown row ${row}`)
    target.dirty = true
    this.damage = RenderStateDirty.Partial
  }

  setCursor(cursor: RenderCursorSnapshot): void {
    this.cursor = cursor
  }
}

function fakeCell(x: number, y: number): RenderCell {
  const background = x === 0 && y === 0 ? { b: 30, g: 20, r: 10 } : undefined
  return {
    background,
    continuation: false,
    selected: false,
    text: x === 1 ? 'A' : '',
    x,
  }
}

async function createDevice(): Promise<GPUDevice> {
  const adapter = await requestAdapter()
  const device = await adapter.requestDevice()
  devices.add(device)
  return device
}

async function requestAdapter(): Promise<GPUAdapter> {
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  })
  if (!adapter) throw new Error('WebGPU requestAdapter returned null')
  return adapter
}

async function waitForDeviceCleanup(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, deviceCleanupDelayMs))
}

async function createRenderer(
  options: WebGpuTerminalRendererOptions,
): Promise<WebGpuTerminalRenderer> {
  await attachNativeTestBuilder(options.renderState, options.columns, options.rows)
  const renderer = await WebGpuTerminalRenderer.create({
    deviceFactory: createDevice,
    ...options,
  })
  renderers.add(renderer)
  return renderer
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  return canvas
}

function fittedFont(
  cellWidth = 8,
  cellHeight = 16,
  pixelRatio = 1,
  settings: Partial<TerminalFontSettings> = {},
): TerminalFittedFont {
  const deviceCellWidth = Math.round(cellWidth * pixelRatio)
  const deviceCellHeight = Math.round(cellHeight * pixelRatio)
  const size = settings.size ?? 14
  const deviceCharHeight = Math.min(deviceCellHeight, Math.ceil(size * pixelRatio))
  const charTop = Math.round((deviceCellHeight - deviceCharHeight) / 2)
  return Object.freeze({
    charLeft: 0,
    charTop,
    cssCellHeight: deviceCellHeight / pixelRatio,
    cssCellWidth: deviceCellWidth / pixelRatio,
    deviceBaseline: charTop + Math.ceil(deviceCharHeight * 0.8),
    deviceCellHeight,
    deviceCellWidth,
    deviceCharHeight,
    deviceCharWidth: deviceCellWidth,
    pixelRatio,
    settings: Object.freeze({
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: deviceCellHeight / deviceCharHeight,
      size,
      weight: 400,
      ...settings,
    }),
  })
}

it('coalesces damage, uploads only dirty rows, and leaves clean idle empty', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(),
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()

  expect(renderer.metrics.submittedFrames).toBe(1)
  expect(renderer.metrics.rebuiltRows).toBe(2)
  expect(renderer.metrics.instanceUploadOperations).toBe(4)
  expect(renderer.metrics.atlasCacheHits).toBe(0)
  expect(renderer.metrics.atlasCacheMisses).toBe(1)
  expect(renderer.metrics.atlasPages).toBe(1)
  expect(renderer.metrics.atlasUploadOperations).toBe(1)
  expect(renderer.metrics.atlasUploadedBytes).toBeGreaterThan(0)
  expect(renderer.metrics.atlasUploadedBytes).toBeLessThan(512 * 512)
  expect(source.acknowledgements).toBe(1)
  expect(renderer.hasPendingFrame).toBe(false)
  expect(renderer.hasPendingTimer).toBe(false)

  renderer.schedule()
  clock.flushFrame()
  expect(renderer.metrics.submittedFrames).toBe(1)

  source.dirtyRow(1)
  for (let write = 0; write < 1_000; write += 1) renderer.notifyWrite()
  expect(clock.frames.size).toBe(1)
  clock.flushFrame()

  expect(renderer.metrics.submittedFrames).toBe(2)
  expect(renderer.metrics.rebuiltRows).toBe(2)
  expect(renderer.metrics.instanceUploadOperations).toBe(4)
  expect(source.acknowledgements).toBe(2)
  renderer.dispose()
  canvas.remove()
})

it('schedules bounded row refreshes and texture-atlas clears without a standing loop', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 3)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(),
    renderState: source,
    rows: 3,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const initialDraws = renderer.metrics.draws
  const initialRows = renderer.metrics.rebuiltRows

  renderer.refreshRows(1, 1)
  renderer.refreshRows(1, 1)
  expect(clock.frames.size).toBe(1)
  clock.flushFrame()
  expect(renderer.metrics.rebuiltRows).toBe(initialRows + 1)
  expect(renderer.metrics.draws).toBe(initialDraws + 2)
  expect(clock.frames.size).toBe(0)

  renderer.clearTextureAtlas()
  renderer.clearTextureAtlas()
  expect(clock.frames.size).toBe(1)
  clock.flushFrame()
  expect(renderer.metrics.rebuiltRows).toBe(initialRows + 4)
  expect(renderer.metrics.draws).toBe(initialDraws + 4)
  expect(clock.frames.size).toBe(0)
  expect(() => renderer.refreshRows(2, 1)).toThrow('startRow must not exceed endRow')
  expect(() => renderer.refreshRows(0, 3)).toThrow('renderer row count')

  renderer.dispose()
  canvas.remove()
})

it('submits one frame per blink transition without a standing animation frame', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(),
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  renderer.setCursorBlinkEnabled(true)
  renderer.setFocused(true)
  clock.flushFrame()
  const beforeBlink = renderer.metrics.submittedFrames

  expect(clock.frames.size).toBe(0)
  expect(clock.timers.size).toBe(1)
  clock.flushTimer()
  expect(clock.frames.size).toBe(1)
  clock.flushFrame()
  expect(renderer.metrics.submittedFrames).toBe(beforeBlink + 1)
  expect(clock.frames.size).toBe(0)
  expect(clock.timers.size).toBe(1)

  renderer.notifyWrite()
  expect(clock.frames.size).toBe(1)
  expect(clock.timers.size).toBe(1)
  clock.flushFrame()
  expect(renderer.metrics.submittedFrames).toBe(beforeBlink + 2)

  renderer.setDocumentVisible(false)
  expect(clock.frames.size).toBe(0)
  expect(clock.timers.size).toBe(0)
  renderer.dispose()
  canvas.remove()
})

it('renders cursor-only terminal mutations even when row damage is clean', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const frames: RendererFrameSnapshot[] = []
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(),
    onFrame: (snapshot) => frames.push(snapshot),
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const rebuilt = renderer.metrics.rebuiltRows

  source.setCursor({
    blinking: false,
    passwordInput: false,
    style: 'underline',
    viewport: { wideTail: false, x: 1, y: 1 },
    visible: true,
  })
  renderer.schedule()
  clock.flushFrame()

  expect(renderer.metrics.rebuiltRows).toBe(rebuilt + 2)
  expect(frames.at(-1)?.cursor).toMatchObject({
    style: 'underline',
    viewport: { x: 1, y: 1 },
  })
  expect(source.acknowledgements).toBe(1)
  renderer.dispose()
  canvas.remove()
})

it('keeps cursor and refresh paints free of styled-row reads', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 5)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(),
    renderState: source,
    rows: 5,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const readRows = vi.spyOn(source, 'readRows')

  source.setCursor({
    ...source.readCursor(),
    viewport: { wideTail: false, x: 1, y: 0 },
  })
  source.dirtyRow(0)
  renderer.notifyWrite()
  clock.flushFrame()
  expect(readRows).not.toHaveBeenCalled()

  readRows.mockClear()
  source.setCursor({
    ...source.readCursor(),
    viewport: { wideTail: false, x: 1, y: 3 },
  })
  renderer.schedule()
  clock.flushFrame()
  expect(readRows).not.toHaveBeenCalled()

  readRows.mockClear()
  renderer.refreshRows(4, 4)
  clock.flushFrame()
  expect(readRows).not.toHaveBeenCalled()
  expect(renderer.hasPendingFrame).toBe(false)
  renderer.dispose()
  canvas.remove()
})

it('separates CSS grid size from DPR backing resources and ignores semantic no-ops', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(8, 16, 2),
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })

  expect(canvas.style.width).toBe('16px')
  expect(canvas.style.height).toBe('32px')
  expect(canvas.width).toBe(32)
  expect(canvas.height).toBe(64)
  clock.flushFrame()
  const rebuilt = renderer.metrics.rebuiltRows

  renderer.resize({ columns: 2, rows: 2 })
  expect(clock.frames.size).toBe(0)

  renderer.setFont(fittedFont(8, 16, 1.5))
  renderer.setFont(fittedFont(8, 16, 1.5))
  expect(clock.frames.size).toBe(1)
  expect(canvas.style.width).toBe('16px')
  expect(canvas.style.height).toBe('32px')
  expect(canvas.width).toBe(24)
  expect(canvas.height).toBe(48)
  clock.flushFrame()
  expect(renderer.metrics.rebuiltRows).toBe(rebuilt + 2)

  renderer.dispose()
  canvas.remove()
})

it('canonicalizes fractional CSS cell metrics to the integer native DPR grid', async () => {
  const clock = new FakeClock()
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(7.8, 15.7, 2),
    renderState: new FakeRenderState(2, 2),
    rows: 2,
    schedulerClock: clock,
  })

  expect(Number.parseFloat(canvas.style.width) * 2).toBe(canvas.width)
  expect(Number.parseFloat(canvas.style.height) * 2).toBe(canvas.height)
  expect(canvas.style.width).toBe('16px')
  expect(canvas.style.height).toBe('31px')
  expect(canvas.width).toBe(32)
  expect(canvas.height).toBe(62)

  renderer.dispose()
  canvas.remove()
})

it('repaints synchronously on resize so the wiped backbuffer is never presented', async () => {
  const clock = new FakeClock()
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(),
    renderState: new FakeRenderState(2, 2),
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const submitted = renderer.metrics.submittedFrames

  renderer.resize({ columns: 3, rows: 2 })
  expect(clock.frames.size).toBe(0)
  expect(renderer.metrics.submittedFrames).toBe(submitted + 1)
  expect(canvas.width).toBe(24)

  renderer.setDocumentVisible(false)
  renderer.resize({ columns: 2, rows: 2 })
  expect(clock.frames.size).toBe(0)
  expect(renderer.metrics.submittedFrames).toBe(submitted + 1)
  renderer.setDocumentVisible(true)
  clock.flushFrame()
  expect(renderer.metrics.submittedFrames).toBe(submitted + 2)

  renderer.dispose()
  canvas.remove()
})

it('coalesces a runtime font change into one full repaint', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(),
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const rebuilt = renderer.metrics.rebuiltRows
  const misses = renderer.metrics.atlasCacheMisses

  renderer.setFont(fittedFont(8, 16, 1, { family: 'serif', size: 15 }))
  renderer.setFont(fittedFont(8, 16, 1, { family: 'serif', size: 15 }))
  expect(clock.frames.size).toBe(1)
  clock.flushFrame()
  expect(renderer.metrics.rebuiltRows).toBe(rebuilt + 2)
  expect(renderer.metrics.atlasCacheMisses).toBe(misses + 1)

  renderer.resize({ columns: 3, rows: 2 })
  expect(clock.frames.size).toBe(0)
  expect(renderer.metrics.atlasCacheMisses).toBe(misses + 1)

  renderer.dispose()
  canvas.remove()
})

it('publishes immutable copied frame state only after submitted frames', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const frames: RendererFrameSnapshot[] = []
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    font: fittedFont(),
    onFrame: (snapshot) => frames.push(snapshot),
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()

  expect(frames).toHaveLength(1)
  expect(frames[0]?.rows.map((row) => row.text)).toEqual([' A', ' A'])
  expect(Object.isFrozen(frames[0]?.rows)).toBe(true)
  expect(Object.isFrozen(frames[0]?.rows[0]?.cells)).toBe(true)
  expect(Object.isFrozen(frames[0]?.rows[0]?.continuations)).toBe(true)
  expect(Object.isFrozen(frames[0]?.cursor.viewport)).toBe(true)
  expect(Object.isFrozen(frames[0]?.paintedCursor)).toBe(true)

  renderer.schedule()
  clock.flushFrame()
  expect(frames).toHaveLength(1)

  source.dirtyRow(1)
  renderer.notifyWrite()
  clock.flushFrame()
  expect(frames).toHaveLength(2)

  renderer.dispose()
  canvas.remove()
})

it('recovers through a replacement device and submits a full repaint', async ({ skip }) => {
  if (deviceReplacement.kind === 'unresolved') expect.fail(deviceReplacement.reason)
  if (deviceReplacement.kind === 'skip') skip(deviceReplacement.reason)
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  let factoryCalls = 0
  const factory = async () => {
    factoryCalls += 1
    return createDevice()
  }
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    deviceFactory: factory,
    font: fittedFont(),
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const uploadedBeforeRestore = renderer.metrics.atlasUploadedBytes
  const operationsBeforeRestore = renderer.metrics.atlasUploadOperations
  await renderer.simulateDeviceLoss()
  expect(factoryCalls).toBe(2)
  expect(renderer.metrics.deviceRestores).toBe(1)
  expect(clock.frames.size).toBe(1)
  clock.flushFrame()

  expect(renderer.metrics.submittedFrames).toBe(2)
  expect(renderer.metrics.rebuiltRows).toBe(4)
  expect(renderer.metrics.atlasUploadedBytes).toBe(uploadedBeforeRestore + 512 * 512)
  expect(renderer.metrics.atlasUploadOperations).toBe(operationsBeforeRestore + 1)
  renderer.dispose()
  canvas.remove()
})

it('discards a replacement device that resolves after disposal', async () => {
  const first = await createDevice()
  let resolveReplacement: ((device: GPUDevice) => void) | undefined
  let calls = 0
  const factory = () => {
    calls += 1
    if (calls === 1) return Promise.resolve(first)
    return new Promise<GPUDevice>((resolve) => {
      resolveReplacement = resolve
    })
  }
  const clock = new FakeClock()
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    deviceFactory: factory,
    font: fittedFont(),
    renderState: new FakeRenderState(2, 2),
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const restoring = renderer.simulateDeviceLoss()
  renderer.dispose()
  await first.lost
  await waitForDeviceCleanup()
  const second = await createDevice()
  resolveReplacement?.(second)
  await restoring

  expect(renderer.metrics.deviceRestores).toBe(0)
  expect(clock.frames.size).toBe(0)
  canvas.remove()
})

it('keeps device replacement retryable after acquisition fails', async ({ skip }) => {
  if (deviceReplacement.kind === 'unresolved') expect.fail(deviceReplacement.reason)
  if (deviceReplacement.kind === 'skip') skip(deviceReplacement.reason)
  const first = await createDevice()
  let calls = 0
  const factory = () => {
    calls += 1
    if (calls === 1) return Promise.resolve(first)
    if (calls === 2) return Promise.reject(new Error('replacement unavailable'))
    return createDevice()
  }
  const clock = new FakeClock()
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    deviceFactory: factory,
    font: fittedFont(),
    renderState: new FakeRenderState(2, 2),
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()

  await renderer.simulateDeviceLoss()
  expect(renderer.metrics.deviceRestores).toBe(0)
  expect(clock.frames.size).toBe(0)
  renderer.schedule()
  clock.flushFrame()
  await expect.poll(() => renderer.metrics.deviceRestores).toBe(1)
  expect(clock.frames.size).toBe(1)

  renderer.dispose()
  canvas.remove()
})

it('unwinds a replacement when post-acquisition setup fails', async () => {
  const first = await createDevice()
  const second = await createDevice()
  const secondDestroy = vi.spyOn(second, 'destroy')
  let calls = 0
  const factory = () => {
    calls += 1
    if (calls === 1) return Promise.resolve(first)
    if (calls === 2) return Promise.resolve(second)
    return createDevice()
  }
  const clock = new FakeClock()
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 2,
    deviceFactory: factory,
    font: fittedFont(),
    renderState: new FakeRenderState(2, 2),
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const context = canvas.getContext('webgpu')
  if (!context) throw new TypeError('Expected a WebGPU context')
  const configure = vi.spyOn(context, 'configure').mockImplementationOnce(() => {
    throw new TypeError('replacement configure failed')
  })

  await renderer.simulateDeviceLoss()
  expect(renderer.metrics.deviceRestores).toBe(0)
  expect(secondDestroy).toHaveBeenCalledOnce()
  await second.lost
  await waitForDeviceCleanup()
  configure.mockRestore()
  renderer.schedule()
  clock.flushFrame()
  await expect.poll(() => renderer.metrics.deviceRestores).toBe(1)

  renderer.dispose()
  canvas.remove()
})

it('validates before acquisition and destroys a device after constructor failure', async () => {
  const canvas = createCanvas()
  let calls = 0
  await expect(
    createRenderer({
      canvas,
      columns: 2,
      deviceFactory: async () => {
        calls += 1
        return createDevice()
      },
      font: { ...fittedFont(), deviceCellHeight: 0 },
      renderState: new FakeRenderState(2, 2),
      rows: 2,
    }),
  ).rejects.toThrow(RangeError)
  expect(calls).toBe(0)

  const device = await createDevice()
  const destroy = vi.spyOn(device, 'destroy')
  const context = canvas.getContext('webgpu')
  if (!context) throw new TypeError('Expected a WebGPU context')
  const configure = vi.spyOn(context, 'configure').mockImplementationOnce(() => {
    throw new TypeError('initial configure failed')
  })
  await expect(
    createRenderer({
      canvas,
      columns: 2,
      deviceFactory: () => Promise.resolve(device),
      font: fittedFont(),
      renderState: new FakeRenderState(2, 2),
      rows: 2,
    }),
  ).rejects.toThrow('initial configure failed')
  expect(destroy).toHaveBeenCalledOnce()
  configure.mockRestore()
  canvas.remove()
})

it('consumes the real libghostty-vt damage contract in a browser', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
  const state = runtime.createRenderState(terminal)
  const clock = new FakeClock()
  const frames: RendererFrameSnapshot[] = []
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    columns: 4,
    font: fittedFont(),
    onFrame: (snapshot) => frames.push(snapshot),
    renderState: state,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const rebuilt = renderer.metrics.rebuiltRows
  terminal.write('X')
  renderer.notifyWrite()
  clock.flushFrame()

  expect(renderer.metrics.rebuiltRows).toBe(rebuilt + 1)
  expect(renderer.metrics.submittedFrames).toBe(2)

  terminal.write('\u001b[3 q')
  renderer.notifyWrite()
  clock.flushFrame()
  expect(renderer.metrics.submittedFrames).toBe(3)
  expect(frames.at(-1)?.cursor).toMatchObject({
    blinking: true,
    style: 'underline',
  })

  terminal.write('\u001b[?25l')
  renderer.notifyWrite()
  clock.flushFrame()
  expect(renderer.metrics.submittedFrames).toBe(4)
  expect(frames.at(-1)?.cursor.visible).toBe(false)
  renderer.dispose()
  state.dispose()
  terminal.dispose()
  runtime.dispose()
  canvas.remove()
})

it('paints WASM ASCII and Unicode frames without JS row reads', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 3 })
  const state = runtime.createRenderState(terminal)
  terminal.write(
    '\x1b[?25l\x1b[31;44mANSI\x1b[0m plain changed\r\n\x1b[38;5;202mindexed\r\n\x1b[38;2;10;80;200mRGB',
  )
  const readRows = vi.spyOn(state, 'readRows')
  const nativeClock = new FakeClock()
  const jsClock = new FakeClock()
  const native = await createRenderer({
    canvas: createCanvas(),
    columns: 24,
    rows: 3,
    font: fittedFont(),
    renderState: state,
    schedulerClock: nativeClock,
  })
  const js = await createRenderer({
    canvas: createCanvas(),
    columns: 24,
    rows: 3,
    font: fittedFont(),
    renderState: state,
    schedulerClock: jsClock,
  })
  try {
    nativeClock.flushFrame()
    expect(native.metrics.zigFrames).toBe(1)
    expect(readRows).not.toHaveBeenCalled()
    jsClock.flushFrame()
    const [nativePixels, jsPixels] = await Promise.all([native.capturePixels(), js.capturePixels()])
    expect(nativePixels).toEqual(jsPixels)
    readRows.mockClear()
    const uploaded = native.metrics.uploadedBytes
    terminal.write('\x1b[2;1Hchanged')
    native.notifyWrite()
    nativeClock.flushFrame()
    expect(native.metrics.zigFrames).toBe(2)
    expect(native.metrics.uploadedBytes - uploaded).toBeGreaterThan(0)
    expect(native.metrics.uploadedBytes - uploaded).toBeLessThanOrEqual(24 * (64 + 96))
    expect(readRows).not.toHaveBeenCalled()
    js.refreshRows(0, 2)
    jsClock.flushFrame()
    const [changedNativePixels, changedJsPixels] = await Promise.all([
      native.capturePixels(),
      js.capturePixels(),
    ])
    expect(changedNativePixels).toEqual(changedJsPixels)
    readRows.mockClear()
    terminal.write('\x1b[3;1H界')
    native.notifyWrite()
    nativeClock.flushFrame()
    expect(native.metrics.zigFrames).toBe(3)
    expect(readRows).not.toHaveBeenCalled()
    terminal.write('\x1b[3;1H\x1b[2KASCII')
    readRows.mockClear()
    native.notifyWrite()
    nativeClock.flushFrame()
    expect(native.metrics.zigFrames).toBe(4)
    expect(readRows).not.toHaveBeenCalled()
  } finally {
    native.dispose()
    js.dispose()
    runtime.dispose()
  }
})

it('keeps native frame callbacks current for DOM text and cursor consumers', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 2 })
  const state = runtime.createRenderState(terminal)
  const clock = new FakeClock()
  const onFrame = vi.fn()
  const onRowsPainted = vi.fn()
  terminal.write('first')
  const renderer = await createRenderer({
    canvas: createCanvas(),
    columns: 16,
    rows: 2,
    font: fittedFont(),
    renderState: state,
    schedulerClock: clock,

    onFrame,
    onRowsPainted,
  })
  try {
    clock.flushFrame()
    expect(onFrame.mock.calls.at(-1)![0].rows[0].text.trimEnd()).toBe('first')
    expect(onFrame.mock.calls.at(-1)![0].cursor.viewport.x).toBe(5)
    expect(onRowsPainted).toHaveBeenCalledTimes(1)
    terminal.write('\rsecond')
    renderer.notifyWrite()
    clock.flushFrame()
    expect(onFrame.mock.calls.at(-1)![0].rows[0].text.trimEnd()).toBe('second')
    expect(onFrame.mock.calls.at(-1)![0].cursor.viewport.x).toBe(6)
    expect(renderer.metrics.zigFrames).toBe(2)
  } finally {
    renderer.dispose()
    runtime.dispose()
  }
})

it('delivers both paint callbacks before a nested resize repaint', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 8, rows: 4 })
  const state = runtime.createRenderState(terminal)
  const clock = new FakeClock()
  const events: string[] = []
  let resized = false
  terminal.write('first\r\nsecond\r\nthird\r\nfourth')
  const renderer = await createRenderer({
    canvas: new OffscreenCanvas(1, 1),
    columns: 8,
    rows: 4,
    font: fittedFont(),
    renderState: state,
    schedulerClock: clock,
    onFrame: (frame) => {
      events.push(`frame:${frame.rows.map((row) => row.y).join(',')}`)
      if (resized) return
      resized = true
      terminal.resize({ columns: 8, rows: 2 })
      renderer.resize({ columns: 8, rows: 2 })
    },
    onRowsPainted: (rows) => events.push(`rows:${rows.map((row) => row.y).join(',')}`),
  })
  try {
    clock.flushFrame()
    expect(events).toEqual(['frame:0,1,2,3', 'rows:0,1,2,3', 'frame:0,1', 'rows:0,1'])
    expect(renderer.metrics.submittedFrames).toBe(2)
    expect(renderer.metrics.zigFrames).toBe(2)
    expect(renderer.hasPendingFrame).toBe(false)
  } finally {
    renderer.dispose()
    runtime.dispose()
  }
})

it('drops queued Zig overlay rows when the grid shrinks before painting', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 8, rows: 128 })
  const state = runtime.createRenderState(terminal)
  const clock = new FakeClock()
  terminal.write('first')
  const renderer = await createRenderer({
    canvas: createCanvas(),
    columns: 8,
    rows: 128,
    font: fittedFont(),
    renderState: state,
    schedulerClock: clock,
  })
  try {
    clock.flushFrame()
    renderer.refreshRows(127, 127)
    terminal.resize({ columns: 8, rows: 2 })
    const createBuilder = state.createFrameBuilder.bind(state)
    vi.spyOn(state, 'createFrameBuilder').mockImplementation((columns, rows) => {
      const builder = createBuilder(columns, rows)
      const build = builder.build.bind(builder)
      vi.spyOn(builder, 'build').mockImplementation((options) => {
        expect([...options.overlayRows].every((row) => row >= 0 && row < rows)).toBe(true)
        return build(options)
      })
      return builder
    })
    renderer.resize({ columns: 8, rows: 2 })
    expect(renderer.metrics.zigFrames).toBe(2)
  } finally {
    renderer.dispose()
    runtime.dispose()
  }
})

it.each(['onFrame', 'onRowsPainted'] as const)(
  'retains theme and row invalidation requested by a Zig %s callback',
  async (callback) => {
    const runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
    const state = runtime.createRenderState(terminal)
    const clock = new FakeClock()
    terminal.write('first')
    let invalidate: (() => void) | undefined
    const onPaint = vi.fn(() => {
      const action = invalidate
      invalidate = undefined
      action?.()
    })
    const renderer = await createRenderer({
      canvas: new OffscreenCanvas(1, 1),
      columns: 8,
      rows: 2,
      font: fittedFont(),
      renderState: state,
      schedulerClock: clock,

      [callback]: onPaint,
    })
    try {
      clock.flushFrame()
      const before = await renderer.capturePixels()
      expect(before.some((value) => value !== 0)).toBe(true)
      invalidate = () => renderer.setTheme({ foreground: { r: 80, g: 40, b: 20 } })
      renderer.refreshRows(0, 1)
      clock.flushFrame()
      expect(state.dirty).toBe(RenderStateDirty.False)
      clock.flushFrame()
      expect(renderer.metrics.zigFrames).toBe(3)
      expect(await renderer.capturePixels()).not.toEqual(before)
      invalidate = () => renderer.refreshRows(1, 1)
      renderer.refreshRows(0, 0)
      clock.flushFrame()
      clock.flushFrame()
      expect(renderer.metrics.zigFrames).toBe(5)
      expect(onPaint.mock.calls).toHaveLength(5)
    } finally {
      renderer.dispose()
      runtime.dispose()
    }
  },
)

it('recovers after a Zig builder replacement allocation fails', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
  const state = runtime.createRenderState(terminal)
  const clock = new FakeClock()
  terminal.write('first')
  const onError = vi.fn()
  const renderer = await createRenderer({
    canvas: new OffscreenCanvas(1, 1),
    columns: 8,
    rows: 2,
    font: fittedFont(),
    renderState: state,
    schedulerClock: clock,
    onError,
  })
  try {
    clock.flushFrame()
    terminal.resize({ columns: 9, rows: 2 })
    const allocate = runtime.memory.allocate.bind(runtime.memory)
    const injected = createGhosttyError('ghostty_wasm_alloc', 'Injected allocation failure')
    let calls = 0
    const failing = vi.spyOn(runtime.memory, 'allocate').mockImplementation((length) => {
      calls += 1
      if (calls === 3) throw injected
      return allocate(length)
    })
    expect(() => renderer.resize({ columns: 9, rows: 2 })).not.toThrow()
    expect(onError).toHaveBeenCalledExactlyOnceWith(injected)
    failing.mockRestore()
    expect(() => renderer.clearTextureAtlas()).not.toThrow()
    terminal.resize({ columns: 8, rows: 2 })
    renderer.resize({ columns: 8, rows: 2 })
    expect(renderer.metrics.zigFrames).toBe(2)
    terminal.resize({ columns: 9, rows: 2 })
    renderer.resize({ columns: 9, rows: 2 })
    expect(renderer.metrics.zigFrames).toBe(3)
  } finally {
    renderer.dispose()
    runtime.dispose()
  }
})

it.each(['onFrame', 'onRowsPainted'] as const)(
  'preserves native terminal damage created by a Zig %s callback',
  async (callback) => {
    const runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
    const state = runtime.createRenderState(terminal)
    const clock = new FakeClock()
    terminal.write('\x1b[?25lfirst')
    let write = false
    const textByRow = new Map<number, string>()
    const onPaint = (frame: RendererFrameSnapshot | readonly RenderRow[]) => {
      const rows = 'rows' in frame ? frame.rows : frame
      for (const row of rows) {
        const text = 'text' in row ? row.text : row.cells.map((cell) => cell.text).join('')
        textByRow.set(row.y, text.trimEnd())
      }
      if (!write) return
      write = false
      terminal.write('\x1b[2;1Hsecond\x1b[1;6H')
      state.update()
      renderer.notifyWrite()
    }
    const renderer = await createRenderer({
      canvas: new OffscreenCanvas(1, 1),
      columns: 8,
      rows: 2,
      font: fittedFont(),
      renderState: state,
      schedulerClock: clock,

      [callback]: onPaint,
    })
    try {
      clock.flushFrame()
      expect(textByRow.get(0)).toBe('first')
      expect(textByRow.get(1)).toBe('')
      write = true
      terminal.write('\x1b[1;1Halter')
      renderer.notifyWrite()
      clock.flushFrame()
      clock.flushFrame()
      expect(renderer.metrics.zigFrames).toBe(3)
      expect(textByRow.get(0)).toBe('alter')
      expect(textByRow.get(1)).toBe('second')
      expect(state.dirty).toBe(RenderStateDirty.False)
    } finally {
      renderer.dispose()
      runtime.dispose()
    }
  },
)

it('copies no native listener rows for cursor and painted-row ID consumers, then resumes full snapshots', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
  const state = runtime.createRenderState(terminal)
  const clock = new FakeClock()
  const onFrame = vi.fn()
  const onRowsChanged = vi.fn()
  const readRows = vi.spyOn(state, 'readRows')
  let needsRows = false
  terminal.write('first\r\nsecond\r\nthird')
  const renderer = await createRenderer({
    canvas: createCanvas(),
    columns: 16,
    rows: 3,
    font: fittedFont(),
    renderState: state,
    schedulerClock: clock,

    onFrame,
    onRowsChanged,
    needsFrameRows: () => needsRows,
  })
  try {
    clock.flushFrame()
    expect(readRows).not.toHaveBeenCalled()
    expect(onFrame.mock.calls.at(-1)![0].rows).toEqual([])
    expect(onFrame.mock.calls.at(-1)![0].cursor.viewport).toMatchObject({
      x: 5,
      y: 2,
    })
    expect(onRowsChanged.mock.calls.at(-1)![0]).toEqual([0, 1, 2])
    expect(Object.isFrozen(onRowsChanged.mock.calls.at(-1)![0])).toBe(true)
    terminal.write('\rthird changed')
    renderer.notifyWrite()
    clock.flushFrame()
    expect(readRows).not.toHaveBeenCalled()
    needsRows = true
    terminal.write('\rthird again')
    renderer.notifyWrite()
    clock.flushFrame()
    const retained = onFrame.mock.calls.at(-1)![0] as RendererFrameSnapshot
    expect(retained.rows.map((row) => row.text.trimEnd())).toEqual([
      'first',
      'second',
      'third agained',
    ])
    expect(readRows.mock.calls.some(([options]) => !options?.dirtyOnly && !options?.rows)).toBe(
      true,
    )
    const text = retained.rows.map((row) => row.text)
    needsRows = false
    readRows.mockClear()
    terminal.write('\rnew\x1b[K')
    renderer.notifyWrite()
    clock.flushFrame()
    expect(readRows).not.toHaveBeenCalled()
    expect(retained.rows.map((row) => row.text)).toEqual(text)
  } finally {
    renderer.dispose()
    runtime.dispose()
  }
})

it('restores the whole resized viewport after cursor-only callback demand', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
  const state = runtime.createRenderState(terminal)
  const canvas = createCanvas()
  let demand = false
  const frames: RendererFrameSnapshot[] = []
  const observer = new FrameObserver({
    canvas,
    columns: 12,
    rows: 3,
    font: fittedFont(),
    renderState: state,
    needsFrameRows: () => demand,
    onFrame: (snapshot) => frames.push(snapshot),
  })
  try {
    terminal.write('one\r\ntwo\r\nthree')
    state.update()
    observer.emit(state, state.readCursor(), undefined, [0, 1, 2])
    terminal.resize({ columns: 12, rows: 5 })
    state.update()
    observer.resize(5)
    observer.emit(state, state.readCursor(), undefined, [0, 1, 2, 3, 4])
    demand = true
    const partial = state.readRows({ rows: new Set([0, 1, 2]), packed: true })
    observer.emit(state, state.readCursor(), undefined, [0, 1, 2], partial)
    expect(frames.at(-1)?.rows.map((row) => row.y)).toEqual([0, 1, 2, 3, 4])
    expect(frames.at(-1)?.rows.map((row) => row.text)).toEqual(
      state.readTextRows().map((row) => row.text),
    )
  } finally {
    state.dispose()
    terminal.dispose()
    runtime.dispose()
    canvas.remove()
  }
})

it('keeps reentrant frame identities intact and delivers only the newest text frame', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 12, rows: 1 })
  const state = runtime.createRenderState(terminal)
  const canvas = createCanvas()
  const fullFrames: RendererFrameSnapshot[] = []
  const textFrames: { x: number | undefined; text: string | undefined }[] = []
  let nested = false
  const observer = new FrameObserver({
    canvas,
    columns: 12,
    rows: 1,
    font: fittedFont(),
    renderState: state,
    onFrame: (snapshot) => {
      fullFrames.push(snapshot)
      if (nested) return
      nested = true
      terminal.write('\r\x1b[2Kinner')
      state.update()
      observer.resize(1)
      observer.emit(state, state.readCursor(), undefined, [0])
    },
    onTextFrame: (snapshot) =>
      textFrames.push({
        x: snapshot.cursor.viewport?.x,
        text: snapshot.rows[0]?.text.trimEnd(),
      }),
  })
  try {
    terminal.write('outer')
    state.update()
    observer.emit(state, state.readCursor(), undefined, [0])
    expect(fullFrames.map((snapshot) => snapshot.rows[0]?.text.trimEnd())).toEqual([
      'outer',
      'inner',
    ])
    expect(textFrames).toEqual([{ x: 5, text: 'inner' }])
    expect(fullFrames[0]?.rows[0]?.text.trimEnd()).toBe('outer')
  } finally {
    state.dispose()
    terminal.dispose()
    runtime.dispose()
    canvas.remove()
  }
})

it.each([
  { paint: true, settlement: 'resolve' },
  { paint: true, settlement: 'reject' },
  { paint: true, settlement: 'throw' },
  { paint: false, settlement: 'resolve' },
])(
  'disposes once and stops pending work ($settlement, painted=$paint)',
  async ({ paint, settlement }) => {
    const clock = new FakeClock()
    const device = await createDevice()
    const canvas = createCanvas()
    const renderer = await createRenderer({
      canvas,
      columns: 2,
      deviceFactory: async () => device,
      font: fittedFont(),
      renderState: new FakeRenderState(2, 2),
      rows: 2,
      schedulerClock: clock,
    })
    if (paint) {
      renderer.setCursorBlinkEnabled(true)
      renderer.setFocused(true)
      clock.flushFrame()
      renderer.schedule()
    }
    const submitted = device.queue.onSubmittedWorkDone()
    const completion = Promise.withResolvers<undefined>()
    const failure = new DOMException('Submitted work was interrupted', 'OperationError')
    const fence = vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValue(completion.promise)
    if (settlement === 'throw')
      fence.mockImplementation(() => {
        throw failure
      })
    const destroy = vi.spyOn(device, 'destroy')
    try {
      expect(renderer.hasPendingFrame).toBe(true)
      expect(renderer.hasPendingTimer).toBe(paint)
      renderer.dispose()
      renderer.dispose()
      renderer.schedule()
      renderer.notifyWrite()
      expect(renderer.hasPendingFrame).toBe(false)
      expect(renderer.hasPendingTimer).toBe(false)
      expect(renderer.metrics.submittedFrames).toBe(paint ? 1 : 0)
      expect(fence).toHaveBeenCalledTimes(1)
      if (settlement === 'throw') expect(destroy).toHaveBeenCalledTimes(1)
      if (settlement !== 'throw') expect(destroy).not.toHaveBeenCalled()
      await submitted.catch(() => {})
      if (settlement !== 'throw') expect(destroy).not.toHaveBeenCalled()
      if (settlement === 'resolve') completion.resolve(undefined)
      if (settlement === 'reject') completion.reject(failure)
      await expect.poll(() => destroy.mock.calls.length).toBe(1)
      await device.lost
      expect(destroy).toHaveBeenCalledTimes(1)
    } finally {
      completion.resolve(undefined)
      try {
        await submitted.catch(() => {})
        device.destroy()
        await device.lost
      } finally {
        fence.mockRestore()
        destroy.mockRestore()
        canvas.remove()
      }
    }
  },
)
