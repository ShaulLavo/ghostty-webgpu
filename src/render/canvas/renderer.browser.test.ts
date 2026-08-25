import { afterEach, describe, expect, it, vi } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type {
  ReadRowsOptions,
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
  RgbColor,
} from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import type { RenderStateSource, WebGpuTerminalRendererOptions } from '../renderer.js'
import { WebGpuUnavailableError } from '../renderer.js'
import type { RenderSchedulerClock } from '../scheduler.js'
import { createCompatibleTerminalRenderer } from '../selector.js'
import { CanvasTerminalRenderer } from './renderer.js'

const canvases = new Set<HTMLCanvasElement>()
const renderers = new Set<CanvasTerminalRenderer>()
const resourceCleanups = new Set<() => void>()

afterEach(() => {
  for (const renderer of renderers) renderer.dispose()
  for (const cleanup of resourceCleanups) cleanup()
  for (const canvas of canvases) canvas.remove()
  renderers.clear()
  resourceCleanups.clear()
  canvases.clear()
  vi.restoreAllMocks()
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
    const entry = this.frames.entries().next().value
    if (!entry) throw new TypeError('No pending frame')
    this.frames.delete(entry[0])
    entry[1]()
  }
}

class FakeRenderState implements RenderStateSource {
  acknowledgements = 0
  cursor: RenderCursorSnapshot = {
    blinking: false,
    passwordInput: false,
    style: 'block',
    viewport: { wideTail: false, x: 1, y: 0 },
    visible: true,
  }
  private damage = RenderStateDirty.Full

  constructor(readonly rows: RenderRow[]) {}

  acknowledge(): number {
    const count = this.rows.filter((row) => row.dirty).length
    for (const row of this.rows) row.dirty = false
    this.damage = RenderStateDirty.False
    this.acknowledgements += 1
    return count
  }

  readCursor(): RenderCursorSnapshot {
    const viewport = this.cursor.viewport ? { ...this.cursor.viewport } : undefined
    return { ...this.cursor, viewport }
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

function fittedFont(): TerminalFittedFont {
  return Object.freeze({
    charLeft: 0,
    charTop: 2,
    cssCellHeight: 20,
    cssCellWidth: 10,
    deviceBaseline: 16,
    deviceCellHeight: 20,
    deviceCellWidth: 10,
    deviceCharHeight: 16,
    deviceCharWidth: 10,
    pixelRatio: 1,
    settings: Object.freeze({
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: 1.25,
      size: 16,
      weight: 400,
    }),
  })
}

function cell(x: number, overrides: Partial<RenderCell> = {}): RenderCell {
  return { continuation: false, selected: false, text: '', x, ...overrides }
}

function row(y: number, cells: readonly RenderCell[]): RenderRow {
  return { cells, dirty: true, y }
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  canvases.add(canvas)
  return canvas
}

function pixel(canvas: HTMLCanvasElement, x: number, y: number): readonly number[] {
  const context = canvas.getContext('2d')
  if (!context) throw new TypeError('Expected a Canvas 2D context')
  return [...context.getImageData(x, y, 1, 1).data]
}

function options(
  canvas: HTMLCanvasElement,
  renderState: RenderStateSource,
  clock: FakeClock,
  overrides: Partial<WebGpuTerminalRendererOptions> = {},
): WebGpuTerminalRendererOptions {
  return {
    canvas,
    columns: 2,
    font: fittedFont(),
    renderState,
    rows: 2,
    schedulerClock: clock,
    ...overrides,
  }
}

async function createRenderer(
  rendererOptions: WebGpuTerminalRendererOptions,
): Promise<CanvasTerminalRenderer> {
  const renderer = await CanvasTerminalRenderer.create(rendererOptions)
  renderers.add(renderer)
  return renderer
}

describe('CanvasTerminalRenderer', () => {
  it('paints Ghostty selection, cursor, and Unicode cells with the fitted font and theme', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const frames: string[][] = []
    const fillText = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText')
    const source = new FakeRenderState([
      row(0, [cell(0, { selected: true }), cell(1, { text: '界' })]),
      row(1, [cell(0), cell(1)]),
    ])
    const renderer = await createRenderer(
      options(canvas, source, clock, {
        onFrame: (snapshot) => frames.push(snapshot.rows.map((frameRow) => frameRow.text)),
        theme: {
          cursor: { b: 0, g: 255, r: 0 },
          selectionBackground: { b: 0, g: 0, r: 255 },
        },
      }),
    )

    clock.flushFrame()

    expect(renderer.backend).toBe('canvas2d')
    expect(canvas.style.width).toBe('20px')
    expect(canvas.style.height).toBe('40px')
    expect(pixel(canvas, 2, 2)).toEqual([255, 0, 0, 255])
    expect(pixel(canvas, 12, 2)).toEqual([0, 255, 0, 255])
    expect(fillText).toHaveBeenCalledWith('界', 15, 16)
    expect(frames).toEqual([[' 界', '  ']])
    expect(source.acknowledgements).toBe(1)
    expect(renderer.hasPendingFrame).toBe(false)
    expect(renderer.hasPendingTimer).toBe(false)
  })

  it('coalesces writes and repaints only native dirty rows without standing work', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const first: RgbColor = { b: 0, g: 0, r: 255 }
    const second: RgbColor = { b: 255, g: 0, r: 0 }
    const source = new FakeRenderState([
      row(0, [cell(0, { background: first }), cell(1, { background: first })]),
      row(1, [cell(0, { background: second }), cell(1, { background: second })]),
    ])
    source.cursor = {
      blinking: false,
      passwordInput: false,
      style: 'block',
      visible: false,
    }
    const renderer = await createRenderer(options(canvas, source, clock))
    clock.flushFrame()
    const initialRows = renderer.metrics.paintedRows

    source.rows[1]!.cells[0]!.background = { b: 0, g: 255, r: 0 }
    source.rows[1]!.cells[1]!.background = { b: 0, g: 255, r: 0 }
    source.dirtyRow(1)
    for (let write = 0; write < 1_000; write += 1) renderer.notifyWrite()

    expect(clock.frames.size).toBe(1)
    clock.flushFrame()
    expect(renderer.metrics.paintedRows).toBe(initialRows + 1)
    expect(pixel(canvas, 2, 2)).toEqual([255, 0, 0, 255])
    expect(pixel(canvas, 2, 22)).toEqual([0, 255, 0, 255])
    expect(clock.frames.size).toBe(0)
    expect(clock.timers.size).toBe(0)

    renderer.schedule()
    clock.flushFrame()
    expect(renderer.metrics.paintedRows).toBe(initialRows + 1)
    expect(clock.frames.size).toBe(0)
  })

  it('consumes GhosttyRenderState directly for native Unicode damage', async () => {
    const runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
    const state = runtime.createRenderState(terminal)
    resourceCleanups.add(() => {
      state.dispose()
      terminal.dispose()
      runtime.dispose()
    })
    const clock = new FakeClock()
    const canvas = createCanvas()
    const frames: string[][] = []
    const renderer = await createRenderer({
      canvas,
      columns: 4,
      font: fittedFont(),
      onFrame: (snapshot) => frames.push(snapshot.rows.map((frameRow) => frameRow.text)),
      renderState: state,
      rows: 2,
      schedulerClock: clock,
    })
    clock.flushFrame()
    const initialRows = renderer.metrics.paintedRows

    terminal.write('界')
    renderer.notifyWrite()
    clock.flushFrame()

    expect(renderer.metrics.paintedRows).toBe(initialRows + 1)
    expect(frames.at(-1)?.[0]).toContain('界')
    expect(renderer.hasPendingFrame).toBe(false)
  })
})

describe('compatible renderer selection', () => {
  it('releases an acquired device and falls back when the WebGPU context is unavailable', async () => {
    const backingCanvas = createCanvas()
    const fakeCanvas = {
      getContext: (type: string) => (type === '2d' ? backingCanvas.getContext('2d') : null),
      height: 1,
      style: backingCanvas.style,
      width: 1,
    } as unknown as HTMLCanvasElement
    const clock = new FakeClock()
    const source = new FakeRenderState([row(0, [cell(0), cell(1)]), row(1, [cell(0), cell(1)])])
    const destroy = vi.fn()
    const renderer = await createCompatibleTerminalRenderer({
      ...options(fakeCanvas, source, clock),
      deviceFactory: () => Promise.resolve({ destroy } as unknown as GPUDevice),
    })

    expect(renderer.backend).toBe('canvas2d')
    expect(destroy).toHaveBeenCalledOnce()
    renderer.dispose()
  })

  it('falls back only for a classified WebGPU capability failure', async () => {
    const canvas = createCanvas()
    const clock = new FakeClock()
    const source = new FakeRenderState([row(0, [cell(0), cell(1)]), row(1, [cell(0), cell(1)])])
    const rendererOptions = options(canvas, source, clock)
    const renderer = await createCompatibleTerminalRenderer({
      ...rendererOptions,
      deviceFactory: () =>
        Promise.reject(new WebGpuUnavailableError('adapter', 'No supported adapter')),
    })

    expect(renderer.backend).toBe('canvas2d')
    renderer.dispose()
  })

  it('does not hide WebGPU programming failures behind the fallback', async () => {
    const canvas = createCanvas()
    const clock = new FakeClock()
    const source = new FakeRenderState([row(0, [cell(0), cell(1)]), row(1, [cell(0), cell(1)])])
    const failure = new TypeError('pipeline setup failed')

    await expect(
      createCompatibleTerminalRenderer({
        ...options(canvas, source, clock),
        deviceFactory: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure)
  })
})
