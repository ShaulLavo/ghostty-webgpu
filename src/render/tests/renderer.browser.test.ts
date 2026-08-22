import { expect, it } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { ReadRowsOptions, RenderCell, RenderRow } from '../../core/types.js'
import { WebGpuTerminalRenderer, type RenderStateSource } from '../renderer.js'
import type { RenderSchedulerClock } from '../scheduler.js'

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

  update(): RenderStateDirty {
    return this.damage
  }

  dirtyRow(row: number): void {
    const target = this.rows[row]
    if (!target) throw new RangeError(`Unknown row ${row}`)
    target.dirty = true
    this.damage = RenderStateDirty.Partial
  }
}

function fakeCell(x: number, y: number): RenderCell {
  const background = x === 0 && y === 0 ? { b: 30, g: 20, r: 10 } : undefined
  return { background, selected: false, text: x === 1 ? 'A' : '', x }
}

async function createDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU requestAdapter returned null')
  return adapter.requestDevice()
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
  const renderer = await WebGpuTerminalRenderer.create({
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
  const renderer = await WebGpuTerminalRenderer.create({
    canvas,
    cellHeight: 16,
    cellWidth: 8,
    columns: 2,
    cursor: { style: 'outline', visible: true, x: 0, y: 0 },
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

  renderer.setDocumentVisible(false)
  expect(clock.frames.size).toBe(0)
  expect(clock.timers.size).toBe(0)
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
  const renderer = await WebGpuTerminalRenderer.create({
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
  const second = await createDevice()
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
  const renderer = await WebGpuTerminalRenderer.create({
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
  resolveReplacement?.(second)
  await restoring

  expect(renderer.metrics.deviceRestores).toBe(0)
  expect(clock.frames.size).toBe(0)
  canvas.remove()
})

it('keeps device replacement retryable after acquisition fails', async () => {
  const first = await createDevice()
  const second = await createDevice()
  let calls = 0
  const factory = () => {
    calls += 1
    if (calls === 1) return Promise.resolve(first)
    if (calls === 2) return Promise.reject(new Error('replacement unavailable'))
    return Promise.resolve(second)
  }
  const clock = new FakeClock()
  const canvas = createCanvas()
  const renderer = await WebGpuTerminalRenderer.create({
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
  await renderer.simulateDeviceLoss()
  expect(renderer.metrics.deviceRestores).toBe(1)
  expect(clock.frames.size).toBe(1)

  renderer.dispose()
  canvas.remove()
})

it('consumes the real libghostty-vt damage contract in a browser', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
  const state = runtime.createRenderState(terminal)
  const clock = new FakeClock()
  const canvas = createCanvas()
  const renderer = await WebGpuTerminalRenderer.create({
    canvas,
    cellHeight: 16,
    cellWidth: 8,
    columns: 4,
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
  renderer.dispose()
  state.dispose()
  terminal.dispose()
  runtime.dispose()
  canvas.remove()
})
