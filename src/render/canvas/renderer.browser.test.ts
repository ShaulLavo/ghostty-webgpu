import { afterEach, describe, expect, it, vi } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type {
  CellStyle,
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
    return this.rows.filter(
      (row) => (!options.dirtyOnly || row.dirty) && (!options.rows || options.rows.has(row.y)),
    )
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

function styled(overrides: Partial<CellStyle>): CellStyle {
  return {
    blink: false,
    bold: false,
    faint: false,
    invisible: false,
    inverse: false,
    italic: false,
    overline: false,
    strikethrough: false,
    underline: 0,
    ...overrides,
  }
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
  it('batches adjacent backgrounds and reuses text drawing state', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const background = { b: 24, g: 16, r: 8 }
    const source = new FakeRenderState(
      Array.from({ length: 2 }, (_, y) =>
        row(
          y,
          Array.from({ length: 80 }, (_, x) => cell(x, { background, text: 'x' })),
        ),
      ),
    )
    source.cursor.visible = false
    const fillRect = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillRect')
    const font = vi.spyOn(CanvasRenderingContext2D.prototype, 'font', 'set')
    const fillStyle = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillStyle', 'set')
    const alpha = vi.spyOn(CanvasRenderingContext2D.prototype, 'globalAlpha', 'set')
    const align = vi.spyOn(CanvasRenderingContext2D.prototype, 'textAlign', 'set')
    await createRenderer(options(canvas, source, clock, { columns: 80 }))

    clock.flushFrame()

    expect({
      alpha: alpha.mock.calls.length,
      backgrounds: fillRect.mock.calls.length,
      fillStyle: fillStyle.mock.calls.length,
      font: font.mock.calls.length,
      textAlign: align.mock.calls.length,
    }).toEqual({ alpha: 0, backgrounds: 2, fillStyle: 4, font: 1, textAlign: 1 })
    expect(pixel(canvas, 2, 2)).toEqual([8, 16, 24, 255])
    expect(pixel(canvas, 792, 22)).toEqual([8, 16, 24, 255])
  })

  it('decodes only affected rows for cursor-only frames', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(0, [cell(0), cell(1)]),
      row(1, [cell(0), cell(1)]),
      row(2, [cell(0), cell(1)]),
    ])
    const readRows = vi.spyOn(source, 'readRows')
    const renderer = await createRenderer(options(canvas, source, clock, { rows: 3 }))
    clock.flushFrame()
    readRows.mockClear()

    source.cursor.viewport = { wideTail: false, x: 0, y: 1 }
    renderer.schedule()
    clock.flushFrame()

    expect(readRows).toHaveBeenCalledExactlyOnceWith({ rows: new Set([0, 1]) })
    expect(pixel(canvas, 12, 2)).toEqual([0, 0, 0, 0])
    expect(pixel(canvas, 2, 22)[3]).toBe(255)
  })

  it('limits repainting when a custom source ignores the optional row filter', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(0, [cell(0), cell(1)]),
      row(1, [cell(0), cell(1)]),
      row(2, [cell(0, { background: { r: 0, g: 0, b: 255 } }), cell(1)]),
    ])
    const legacySource: RenderStateSource = {
      acknowledge: () => source.acknowledge(),
      readCursor: () => source.readCursor(),
      readRows: (options) => source.readRows({ dirtyOnly: options?.dirtyOnly }),
      update: () => source.update(),
    }
    const renderer = await createRenderer(options(canvas, legacySource, clock, { rows: 3 }))
    clock.flushFrame()
    const clearRect = vi.spyOn(CanvasRenderingContext2D.prototype, 'clearRect')

    renderer.refreshRows(2, 2)
    clock.flushFrame()
    expect(clearRect.mock.calls).toEqual([[0, 40, 20, 20]])
    expect(renderer.metrics.paintedRows).toBe(4)

    clearRect.mockClear()
    source.cursor.viewport = { wideTail: false, x: 0, y: 1 }
    renderer.schedule()
    clock.flushFrame()
    expect(clearRect.mock.calls).toEqual([
      [0, 0, 20, 20],
      [0, 20, 20, 20],
    ])
    expect(renderer.metrics.paintedRows).toBe(6)
    expect(pixel(canvas, 12, 2)).toEqual([0, 0, 0, 0])
    expect(pixel(canvas, 2, 22)[3]).toBe(255)
    expect(pixel(canvas, 2, 42)).toEqual([0, 0, 255, 255])
    expect(renderer.hasPendingFrame).toBe(false)
  })

  it('preserves faint, italic, wide and invisible glyphs while reusing text state', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(0, [
        cell(0, { style: styled({ bold: true, faint: true }), text: 'A' }),
        cell(1, { style: styled({ italic: true }), text: 'B' }),
        cell(2, { text: '界' }),
        cell(3, { continuation: true }),
        cell(4, { style: styled({ invisible: true, underline: 1 }), text: 'X' }),
        cell(5, {
          style: styled({ overline: true, strikethrough: true, underline: 2 }),
          text: 'é',
        }),
      ]),
      row(1, [cell(0, { text: 'C' }), cell(1, { text: 'D' })]),
    ])
    source.cursor.visible = false
    const glyphs: { alpha: number; font: string; text: string; x: number }[] = []
    const original = CanvasRenderingContext2D.prototype.fillText
    vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText').mockImplementation(
      function (this: CanvasRenderingContext2D, text, x, y) {
        glyphs.push({ alpha: this.globalAlpha, font: this.font, text, x })
        original.call(this, text, x, y)
      },
    )
    await createRenderer(options(canvas, source, clock, { columns: 6 }))

    clock.flushFrame()

    expect(glyphs.map(({ alpha, text, x }) => ({ alpha, text, x }))).toEqual([
      { alpha: 0.5, text: 'A', x: 5 },
      { alpha: 1, text: 'B', x: 15 },
      { alpha: 1, text: '界', x: 30 },
      { alpha: 1, text: 'é', x: 55 },
      { alpha: 1, text: 'C', x: 5 },
      { alpha: 1, text: 'D', x: 15 },
    ])
    expect(glyphs[0]?.font).toMatch(/\b(?:bold|700)\b/u)
    expect(glyphs[1]?.font).toContain('italic')
    expect(glyphs[2]?.font).not.toContain('italic')
    expect(glyphs[4]?.font).toBe(glyphs[2]?.font)
    expect(pixel(canvas, 42, 18)[3]).toBe(255)
    expect(pixel(canvas, 52, 1)[3]).toBe(255)
    expect(pixel(canvas, 52, 15)[3]).toBe(255)
    expect(pixel(canvas, 42, 2)).toEqual([0, 0, 0, 0])
  })

  it('invalidates cached colors for live contrast and selection themes', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(0, [cell(0, { text: 'A' }), cell(1, { selected: true, text: 'B' })]),
      row(1, [cell(0), cell(1)]),
    ])
    source.cursor.visible = false
    const glyphColors: string[] = []
    const original = CanvasRenderingContext2D.prototype.fillText
    vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText').mockImplementation(
      function (this: CanvasRenderingContext2D, text, x, y) {
        glyphColors.push(String(this.fillStyle))
        original.call(this, text, x, y)
      },
    )
    const renderer = await createRenderer(
      options(canvas, source, clock, {
        theme: {
          background: { b: 0, g: 0, r: 0 },
          foreground: { b: 120, g: 120, r: 120 },
          minimumContrast: 1,
          selectionBackground: { b: 0, g: 0, r: 255 },
          selectionForeground: { b: 0, g: 0, r: 0 },
        },
      }),
    )
    clock.flushFrame()
    expect(glyphColors.splice(0)).toEqual(['#787878', '#000000'])

    renderer.setTheme({
      minimumContrast: 21,
      selectionBackground: { b: 0, g: 255, r: 0 },
    })
    clock.flushFrame()

    expect(glyphColors).toEqual(['#ffffff', '#000000'])
    expect(pixel(canvas, 12, 2)).toEqual([0, 255, 0, 255])
    expect(pixel(canvas, 2, 2)).toEqual([0, 0, 0, 0])
  })

  it('paints Ghostty selection, cursor, and Unicode cells with the fitted font and theme', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const frames: string[][] = []
    const glyphColors: string[] = []
    const cursorBackgrounds: (readonly number[])[] = []
    const originalFillText = CanvasRenderingContext2D.prototype.fillText
    const fillText = vi
      .spyOn(CanvasRenderingContext2D.prototype, 'fillText')
      .mockImplementation(function (this: CanvasRenderingContext2D, text, x, y, maxWidth) {
        glyphColors.push(String(this.fillStyle))
        // Font-dependent glyph antialiasing can cover this background pixel after drawing.
        cursorBackgrounds.push(pixel(canvas, 12, 2))
        if (maxWidth === undefined) {
          originalFillText.call(this, text, x, y)
          return
        }
        originalFillText.call(this, text, x, y, maxWidth)
      })
    const source = new FakeRenderState([
      row(0, [cell(0, { selected: true }), cell(1, { text: '界' })]),
      row(1, [cell(0), cell(1)]),
    ])
    const renderer = await createRenderer(
      options(canvas, source, clock, {
        onFrame: (snapshot) => frames.push(snapshot.rows.map((frameRow) => frameRow.text)),
        theme: {
          cursor: { b: 0, g: 255, r: 0 },
          cursorText: { b: 255, g: 0, r: 0 },
          selectionBackground: { b: 0, g: 0, r: 255 },
        },
      }),
    )

    clock.flushFrame()

    expect(renderer.backend).toBe('canvas2d')
    expect(canvas.style.width).toBe('20px')
    expect(canvas.style.height).toBe('40px')
    expect(pixel(canvas, 2, 2)).toEqual([255, 0, 0, 255])
    expect(cursorBackgrounds).toEqual([[0, 255, 0, 255]])
    expect(fillText).toHaveBeenCalledWith('界', 15, 16)
    expect(glyphColors).toEqual(['#0000ff'])
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

  it('falls back to Canvas2D when WebGPU and WebGL2 are unavailable', async () => {
    const canvas = createCanvas()
    const getContext = canvas.getContext.bind(canvas)
    Object.defineProperty(canvas, 'getContext', {
      configurable: true,
      value: (type: string, attributes?: unknown) =>
        type === 'webgl2' ? null : getContext(type, attributes),
    })
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
