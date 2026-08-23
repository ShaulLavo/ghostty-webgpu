import { afterEach, expect, it, vi } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type {
  ReadRowsOptions,
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
} from '../../core/types.js'
import {
  WebGpuTerminalRenderer,
  type RendererFrameSnapshot,
  type RenderStateSource,
  type WebGpuTerminalRendererOptions,
} from '../renderer.js'
import type { RenderSchedulerClock } from '../scheduler.js'

const devices = new Set<GPUDevice>()
const renderers = new Set<WebGpuTerminalRenderer>()
// Chromium's SwiftShader adapter lags configured-canvas teardown on Linux.
const deviceCleanupDelayMs = navigator.userAgent.includes('Linux') ? 50 : 0

afterEach(async () => {
  for (const renderer of renderers) renderer.dispose()
  renderers.clear()
  const losses = [...devices].map((device) => device.lost)
  for (const device of devices) device.destroy()
  await Promise.all(losses)
  devices.clear()
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
    if (!options.dirtyOnly) return this.rows
    return this.rows.filter((row) => row.dirty)
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
  return { background, continuation: false, selected: false, text: x === 1 ? 'A' : '', x }
}

async function createDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU requestAdapter returned null')
  const device = await adapter.requestDevice()
  devices.add(device)
  return device
}

async function waitForDeviceCleanup(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, deviceCleanupDelayMs))
}

async function createRenderer(
  options: WebGpuTerminalRendererOptions,
): Promise<WebGpuTerminalRenderer> {
  const renderer = await WebGpuTerminalRenderer.create({ deviceFactory: createDevice, ...options })
  renderers.add(renderer)
  return renderer
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  return canvas
}

it('coalesces damage, uploads only dirty rows, and leaves clean idle empty', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()

  expect(renderer.metrics.submittedFrames).toBe(1)
  expect(renderer.metrics.rebuiltRows).toBe(2)
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
  expect(renderer.metrics.rebuiltRows).toBe(3)
  expect(source.acknowledgements).toBe(2)
  renderer.dispose()
  canvas.remove()
})

it('submits one frame per blink transition without a standing animation frame', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
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
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
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

it('separates CSS grid size from DPR backing resources and ignores semantic no-ops', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    pixelRatio: 2,
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

  renderer.resize({ cellHeight: 16, cellWidth: 8, columns: 2, pixelRatio: 2, rows: 2 })
  expect(clock.frames.size).toBe(0)

  renderer.resize({ cellHeight: 16, cellWidth: 8, columns: 2, pixelRatio: 1.5, rows: 2 })
  renderer.resize({ cellHeight: 16, cellWidth: 8, columns: 2, pixelRatio: 1.5, rows: 2 })
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
    cellHeight: 15.7,
    cellWidth: 7.8,
    columns: 2,
    pixelRatio: 2,
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

it('coalesces a runtime font change into one full repaint', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const rebuilt = renderer.metrics.rebuiltRows

  renderer.setFont('serif', 15)
  renderer.setFont('serif', 15)
  expect(clock.frames.size).toBe(1)
  clock.flushFrame()
  expect(renderer.metrics.rebuiltRows).toBe(rebuilt + 2)

  renderer.dispose()
  canvas.remove()
})

it('renders a native wide-tail cursor over the leading wide cell', async () => {
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 1)
  const canvas = createCanvas()
  const renderer = await createRenderer({
    canvas,
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    renderState: source,
    rows: 1,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const leadingCell = await renderer.capturePixels()

  source.setCursor({
    blinking: false,
    passwordInput: false,
    style: 'block',
    viewport: { wideTail: true, x: 1, y: 0 },
    visible: true,
  })
  renderer.schedule()
  clock.flushFrame()
  const wideTail = await renderer.capturePixels()

  expect(wideTail).toEqual(leadingCell)
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
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
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

it('recovers through a replacement device and repaints pixels', async () => {
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
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    deviceFactory: factory,
    renderState: source,
    rows: 2,
    schedulerClock: clock,
  })
  clock.flushFrame()
  const before = await renderer.capturePixels()
  await renderer.simulateDeviceLoss()
  expect(factoryCalls).toBe(2)
  expect(renderer.metrics.deviceRestores).toBe(1)
  expect(clock.frames.size).toBe(1)
  clock.flushFrame()
  const after = await renderer.capturePixels()

  expect(before.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
  expect(after.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
  expect(renderer.metrics.submittedFrames).toBe(2)
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
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    deviceFactory: factory,
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

it('keeps device replacement retryable after acquisition fails', async () => {
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
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    deviceFactory: factory,
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
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    deviceFactory: factory,
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
      cellHeight: 0,
      cellWidth: 8,
      columns: 2,
      deviceFactory: async () => {
        calls += 1
        return createDevice()
      },
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
      cellHeight: 16,
      cellWidth: 8,
      columns: 2,
      deviceFactory: () => Promise.resolve(device),
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
    cellHeight: 16,
    cellWidth: 8,
    columns: 4,
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
  expect(frames.at(-1)?.cursor).toMatchObject({ blinking: true, style: 'underline' })

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
