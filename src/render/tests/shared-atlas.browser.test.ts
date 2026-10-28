import { afterEach, expect, it, vi } from 'vitest'
import { attachNativeTestBuilder } from './native-state.js'
import { RenderStateDirty } from '../../core/abi.js'
import type {
  ReadRowsOptions,
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
} from '../../core/types.js'
import type { TerminalFittedFont, TerminalFontSettings } from '../../term/types.js'
import { type RenderStateSource, type WebGpuTerminalRendererOptions } from '../shared/types.js'
import { WebGpuTerminalRenderer } from '../webgpu/renderer.js'
import type { RenderSchedulerClock } from '../shared/scheduler.js'
import { FrameCoordinator } from '../shared/frame-coordinator.js'
import { SharedGlyphAtlas } from '../webgpu/shared-atlas.js'
import { sharedAtlasKey } from '../webgpu/atlas-registry.js'
import type { AtlasGpuTextures } from '../webgpu/gpu-textures.js'
import type { GlyphBitmap } from '../shared/atlas/types.js'

const devices = new Set<GPUDevice>()
const renderers = new Set<WebGpuTerminalRenderer>()
const deviceCleanupDelayMs = 50

afterEach(async () => {
  for (const renderer of renderers) await renderer.dispose()
  renderers.clear()
  for (const device of devices) device.destroy()
  devices.clear()
  document.body.replaceChildren()
  await waitForDeviceCleanup()
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

async function waitForDeviceCleanup(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, deviceCleanupDelayMs))
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

interface Terminal {
  readonly canvas: HTMLCanvasElement
  readonly clock: FakeClock
  readonly renderer: WebGpuTerminalRenderer
  readonly source: FakeRenderState
}

async function openTerminal(font = fittedFont()): Promise<Terminal> {
  const canvas = createCanvas()
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  await attachNativeTestBuilder(source, 2, 2)
  const options: WebGpuTerminalRendererOptions = {
    canvas,
    columns: 2,
    rows: 2,
    font,
    renderState: source,
    schedulerClock: clock,
  }
  const renderer = await WebGpuTerminalRenderer.create(options)
  renderers.add(renderer)
  clock.flushFrame()
  return { canvas, clock, renderer, source }
}

function texturesOf(renderer: WebGpuTerminalRenderer): unknown {
  return Reflect.get(Reflect.get(renderer, 'atlasTextures') as object, 'textures')
}

function deviceOf(renderer: WebGpuTerminalRenderer): GPUDevice {
  const device = Reflect.get(renderer, 'device') as GPUDevice
  devices.add(device)
  return device
}

async function repaint(terminal: Terminal): Promise<Uint8Array> {
  terminal.renderer.refreshRows(0, 1)
  terminal.clock.flushFrame()
  return terminal.renderer.capturePixels()
}

it('shares one atlas texture set between terminals with equal fonts and keeps their pixels', async () => {
  const alone = await openTerminal()
  const reference = await repaint(alone)
  expect(reference.some((value) => value !== 0)).toBe(true)
  const peer = await openTerminal()
  expect(texturesOf(peer.renderer)).toBe(texturesOf(alone.renderer))
  expect(deviceOf(peer.renderer)).toBe(deviceOf(alone.renderer))
  expect(await repaint(peer)).toEqual(reference)
  expect(await repaint(alone)).toEqual(reference)
  expect(peer.renderer.metrics.atlasCacheMisses).toBe(0)
  expect(peer.renderer.metrics.atlasCacheHits).toBe(1)
  expect(alone.renderer.metrics.atlasCacheMisses).toBe(1)
})

it('moves only the terminal whose font changes and leaves its peers drawing the shared atlas', async () => {
  const serif = fittedFont(8, 16, 1, { family: 'serif', size: 15 })
  const solo = await openTerminal(serif)
  const serifReference = await repaint(solo)
  await solo.renderer.dispose()
  renderers.delete(solo.renderer)
  const first = await openTerminal()
  const second = await openTerminal()
  const reference = await repaint(first)
  second.renderer.setFont(serif)
  second.clock.flushFrame()
  expect(texturesOf(second.renderer)).not.toBe(texturesOf(first.renderer))
  expect(await repaint(second)).toEqual(serifReference)
  expect(await repaint(first)).toEqual(reference)
  second.renderer.setFont(fittedFont())
  second.clock.flushFrame()
  expect(texturesOf(second.renderer)).toBe(texturesOf(first.renderer))
  expect(await repaint(second)).toEqual(reference)
})

it('rebuilds a sharing terminal from its own eviction queue after a peer clears the atlas', async () => {
  const first = await openTerminal()
  const second = await openTerminal()
  const reference = await repaint(second)
  first.renderer.clearTextureAtlas()
  first.clock.flushFrame()
  const rebuilt = second.renderer.metrics.rebuiltRows
  expect(await repaint(second)).toEqual(reference)
  expect(second.renderer.metrics.rebuiltRows).toBeGreaterThan(rebuilt)
  expect(await repaint(first)).toEqual(reference)
})

it('restores one terminal on a replacement device while its peer keeps the original device', async () => {
  const first = await openTerminal()
  const second = await openTerminal()
  const reference = await repaint(first)
  const original = deviceOf(first.renderer)
  await first.renderer.simulateDeviceLoss()
  expect(deviceOf(first.renderer)).not.toBe(original)
  expect(deviceOf(second.renderer)).toBe(original)
  expect(texturesOf(first.renderer)).not.toBe(texturesOf(second.renderer))
  expect(await repaint(first)).toEqual(reference)
  expect(await repaint(second)).toEqual(reference)
  const destroy = vi.spyOn(original, 'destroy')
  await second.renderer.dispose()
  renderers.delete(second.renderer)
  expect(destroy).toHaveBeenCalledOnce()
  expect(await repaint(first)).toEqual(reference)
})

it('keeps different DPR and font descriptors in different atlas sets', async () => {
  const first = await openTerminal()
  const retina = await openTerminal(fittedFont(8, 16, 2))
  const bold = await openTerminal(fittedFont(8, 16, 1, { boldWeight: 800 }))
  expect(texturesOf(first.renderer)).not.toBe(texturesOf(retina.renderer))
  expect(texturesOf(first.renderer)).not.toBe(texturesOf(bold.renderer))
  expect(sharedAtlasKey(fittedFont())).not.toBe(sharedAtlasKey(fittedFont(8, 16, 2)))
  expect(await repaint(retina)).toEqual(await retina.renderer.capturePixels())
})

it('releases textures only when the last sharing terminal is disposed', async () => {
  const first = await openTerminal()
  const peer = await openTerminal()
  const reference = await repaint(peer)
  const textures = Reflect.get(first.renderer, 'atlasTextures') as AtlasGpuTextures
  const destroy = vi.spyOn(textures, 'destroy')
  await first.renderer.dispose()
  expect(destroy).not.toHaveBeenCalled()
  expect(await repaint(peer)).toEqual(reference)
  await peer.renderer.dispose()
  expect(destroy).toHaveBeenCalledOnce()
})

function fullPage(marker: number): GlyphBitmap {
  return {
    width: 510,
    height: 510,
    kind: 'grayscale',
    offsetX: 0,
    offsetY: 0,
    pixels: new Uint8Array(510 * 510).fill(marker),
  }
}

it.each(['growth', 'invalidation'] as const)(
  'keeps the previous texture alive through %s until the coordinator submits its peer',
  async (change) => {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('No WebGPU adapter')
    const device = await adapter.requestDevice()
    devices.add(device)
    device.pushErrorScope('validation')
    const shared = new SharedGlyphAtlas('pending-growth', fittedFont())
    const owner = {}
    const peer = {}
    shared.attach(owner)
    shared.attach(peer)
    const textures = shared.acquireTextures(device)
    const buffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    try {
      shared.atlas.beginFrame(peer)
      shared.atlas.getOrInsert('first', fullPage(71), -1)
      shared.atlas.endFrame()
      shared.sync(device)
      const previous = textures.texture('grayscale')
      const destroy = vi.spyOn(previous, 'destroy')
      const clock = new FakeClock()
      const coordinator = new FrameCoordinator(clock)
      coordinator.requestFrame(() => {
        const encoder = device.createCommandEncoder()
        encoder.copyTextureToBuffer(
          { texture: previous, origin: { x: 1, y: 1 } },
          { buffer, bytesPerRow: 256 },
          { width: 1, height: 1 },
        )
        shared.beginFrame(peer, device)
        coordinator.submit({
          owner: peer,
          device,
          command: encoder.finish(),
          commit: () => shared.frameSubmitted(peer, device),
          notify: () => {},
          failed: (cause) => {
            throw cause
          },
        })
      })
      coordinator.requestFrame(() => {
        if (change === 'invalidation') shared.invalidate()
        shared.atlas.beginFrame(owner)
        shared.atlas.getOrInsert('next', fullPage(182), -1)
        shared.atlas.endFrame()
        shared.sync(device)
        expect(shared.textures(device).texture('grayscale')).not.toBe(previous)
        expect(destroy).not.toHaveBeenCalled()
      })
      clock.flushFrame()
      expect(destroy).toHaveBeenCalledOnce()
      await buffer.mapAsync(GPUMapMode.READ)
      expect(new Uint8Array(buffer.getMappedRange())[0]).toBe(71)
      buffer.unmap()
      expect(await device.popErrorScope()).toBeNull()
    } finally {
      buffer.destroy()
      shared.releaseTextures(device)
      shared.detach(owner)
      shared.detach(peer)
    }
  },
)

it('restores all sharing terminals after real device loss with one fresh texture generation', async () => {
  const first = await openTerminal()
  const peer = await openTerminal()
  const reference = await repaint(first)
  const original = deviceOf(first.renderer)
  original.destroy()
  await vi.waitFor(() => {
    expect(first.renderer.metrics.deviceRestores).toBe(1)
    expect(peer.renderer.metrics.deviceRestores).toBe(1)
  })
  expect(deviceOf(first.renderer)).not.toBe(original)
  expect(deviceOf(first.renderer)).toBe(deviceOf(peer.renderer))
  expect(texturesOf(first.renderer)).toBe(texturesOf(peer.renderer))
  expect(await repaint(first)).toEqual(reference)
  expect(await repaint(peer)).toEqual(reference)
})

it('keeps the prior font and releases a new owner when font texture allocation fails', async () => {
  const first = await openTerminal()
  const reference = await repaint(first)
  const changed = fittedFont(8, 16, 1, { family: 'serif' })
  vi.spyOn(deviceOf(first.renderer), 'createTexture').mockImplementationOnce(() => {
    throw new Error('font atlas allocation failed')
  })
  expect(() => first.renderer.setFont(changed)).toThrow('font atlas allocation failed')
  const peer = await openTerminal(changed)
  const shared = Reflect.get(peer.renderer, 'sharedAtlas') as SharedGlyphAtlas
  expect(shared.ownerCount).toBe(1)
  expect(await repaint(first)).toEqual(reference)
  first.renderer.setFont(changed)
  first.clock.flushFrame()
  expect(texturesOf(first.renderer)).toBe(texturesOf(peer.renderer))
  expect(await repaint(first)).toEqual(await repaint(peer))
})

it('releases retired textures when the invalidating sharer disposes before repaint and its peer stays idle', async () => {
  const first = await openTerminal()
  const peer = await openTerminal()
  const reference = await repaint(peer)
  const textures = Reflect.get(first.renderer, 'atlasTextures') as AtlasGpuTextures
  const destroy = vi.spyOn(textures, 'destroy')
  const submissions = peer.renderer.metrics.submittedFrames
  expect(peer.clock.frames.size).toBe(0)

  first.renderer.clearTextureAtlas()
  await first.renderer.dispose()
  renderers.delete(first.renderer)

  expect(peer.clock.frames.size).toBe(0)
  expect(peer.renderer.metrics.submittedFrames).toBe(submissions)
  expect(destroy).toHaveBeenCalledOnce()
  expect(await repaint(peer)).toEqual(reference)
})

async function openDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('No WebGPU adapter')
  const device = await adapter.requestDevice()
  devices.add(device)
  return device
}

it.each(['growth', 'invalidation'] as const)(
  'releases idle-device textures during %s while another device has an encoded frame',
  async (change) => {
    const active = await openDevice()
    const idle = await openDevice()
    const shared = new SharedGlyphAtlas('idle-device', fittedFont())
    const owner = {}
    const peer = {}
    shared.attach(owner)
    shared.attach(peer)
    shared.acquireTextures(active)
    shared.acquireTextures(idle)
    const buffer = active.createBuffer({
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    try {
      shared.atlas.getOrInsert('first', fullPage(71), -1)
      shared.sync(active)
      const activeTexture = shared.textures(active).texture('grayscale')
      const idleTexture = shared.textures(idle).texture('grayscale')
      const activeDestroy = vi.spyOn(activeTexture, 'destroy')
      const idleDestroy = vi.spyOn(idleTexture, 'destroy')
      const encoder = active.createCommandEncoder()
      encoder.copyTextureToBuffer(
        { texture: activeTexture, origin: { x: 1, y: 1 } },
        { buffer, bytesPerRow: 256 },
        { width: 1, height: 1 },
      )
      shared.beginFrame(owner, active)
      if (change === 'invalidation') shared.invalidate()
      shared.atlas.getOrInsert('second', fullPage(182), -1)
      shared.sync(active)

      expect(activeDestroy).not.toHaveBeenCalled()
      expect(idleDestroy).toHaveBeenCalledOnce()
      active.queue.submit([encoder.finish()])
      shared.frameSubmitted(owner, active)
      expect(activeDestroy).toHaveBeenCalledOnce()
      await buffer.mapAsync(GPUMapMode.READ)
      expect(new Uint8Array(buffer.getMappedRange())[0]).toBe(71)
      buffer.unmap()
    } finally {
      buffer.destroy()
      shared.releaseTextures(active)
      shared.releaseTextures(idle)
      shared.detach(owner)
      shared.detach(peer)
    }
  },
)
