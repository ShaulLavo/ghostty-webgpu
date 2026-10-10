import { afterEach, describe, expect, it, vi } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import { PACKED_CELL_WORDS, PackedCells } from '../../core/packed-cells.js'
import type {
  CellStyle,
  ReadRowsOptions,
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
  RgbColor,
} from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import { renderCursorState } from '../cursor.js'
import { CanvasRowPainter } from './painter.js'
import { ReferenceTarget } from './tests/reference-target.js'
import { ReferenceRenderer } from './tests/reference-renderer.js'
import type { RenderStateSource, WebGpuTerminalRendererOptions } from '../renderer.js'
import { WebGpuUnavailableError } from '../renderer.js'
import type { RenderSchedulerClock } from '../scheduler.js'
import { createCompatibleTerminalRenderer } from '../selector.js'
import { restoreRendererNavigator, stubRendererNavigator } from '../tests/navigator.js'
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
  restoreRendererNavigator()
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

function expectFullRepaint(
  canvas: HTMLCanvasElement,
  source: RenderStateSource,
  font = fittedFont(),
  theme = canonicalRendererTheme(mergeRendererTheme({})),
): void {
  const control = createCanvas()
  control.width = canvas.width
  control.height = canvas.height
  const context = control.getContext('2d', { alpha: true, willReadFrequently: false })!
  const painter = new CanvasRowPainter(context, font, theme)
  painter.resetContext(font)
  const cursor = renderCursorState(source.readCursor(), true)
  for (const row of source.readRows()) painter.paint(row, cursor, control.width, false)
  const actual = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const expected = context.getImageData(0, 0, control.width, control.height).data
  expect([...actual]).toEqual([...expected])
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
  mode: 'fill-text' | 'pixels' = 'fill-text',
): Promise<CanvasTerminalRenderer> {
  const create = mode === 'pixels' ? ReferenceRenderer.create : CanvasTerminalRenderer.create
  const renderer = await create({
    ...rendererOptions,
    rendererMode: mode === 'pixels' ? 'canvas2d-pixels' : 'canvas2d-fill-text',
  })
  renderers.add(renderer)
  return renderer
}

describe('CanvasTerminalRenderer', () => {
  it('repaints only changed plain-text cells while keeping full-row pixels', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const text = 'edit 0000'.padEnd(40)
    const source = new FakeRenderState([
      row(
        0,
        Array.from(text, (text, x) => cell(x, { text })),
      ),
    ])
    source.cursor.viewport = { wideTail: false, x: 9, y: 0 }
    const renderer = await createRenderer(options(canvas, source, clock, { columns: 40, rows: 1 }))
    clock.flushFrame()
    expectFullRepaint(canvas, source)
    const fillText = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText')
    const clear = vi.spyOn(CanvasRenderingContext2D.prototype, 'clearRect')

    source.rows[0]!.cells[8]!.text = '1'
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    const glyphs = fillText.mock.calls.length
    const cleared = clear.mock.calls.reduce((sum, call) => sum + call[2] * call[3], 0)
    expectFullRepaint(canvas, source)
    expect(glyphs).toBeLessThan(10)
    expect(cleared).toBeLessThan(canvas.width * 20)

    for (const x of [10, 11, 9]) {
      source.cursor.viewport = { wideTail: false, x, y: 0 }
      source.rows[0]!.cells[9]!.text = x === 9 ? ' ' : 'a'
      source.dirtyRow(0)
      renderer.notifyWrite()
      clock.flushFrame()
      expectFullRepaint(canvas, source)
    }
    source.rows[0]!.cells[5]!.style = styled({ italic: true, overline: true })
    source.rows[0]!.cells[5]!.text = 'j'
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expectFullRepaint(canvas, source)
    source.rows[0]!.cells[5]!.style = undefined
    source.rows[0]!.cells[5]!.text = '0'
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expectFullRepaint(canvas, source)
  })

  it('captures plain row keys without serializing cells and preserves styled transitions', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(
        0,
        Array.from({ length: 40 }, (_, x) => cell(x, { text: '0' })),
      ),
    ])
    source.cursor.visible = false
    const renderer = await createRenderer(options(canvas, source, clock, { columns: 40, rows: 1 }))
    const stringify = vi.spyOn(JSON, 'stringify')
    const rowSerializations = () =>
      stringify.mock.calls.filter(
        ([value]) => Array.isArray(value) && typeof value[0]?.x === 'number',
      ).length
    clock.flushFrame()
    expectFullRepaint(canvas, source)
    expect(rowSerializations()).toBe(0)

    source.rows[0]!.cells[8]!.text = '1'
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expectFullRepaint(canvas, source)
    expect(rowSerializations()).toBe(0)

    source.rows[0]!.cells[8]!.style = styled({ italic: true, overline: true })
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expectFullRepaint(canvas, source)
    expect(rowSerializations()).toBeGreaterThan(0)

    source.rows[0]!.cells[8]!.style = undefined
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expectFullRepaint(canvas, source)
  })

  it('paints packed plain edits with one scan and no complete-row materialization', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(
        0,
        Array.from({ length: 40 }, (_, x) => cell(x, { text: '0' })),
      ),
    ])
    source.cursor.visible = false
    const renderer = await createRenderer(options(canvas, source, clock, { columns: 40, rows: 1 }))
    clock.flushFrame()

    const words = new Uint32Array(40 * PACKED_CELL_WORDS)
    for (let x = 0; x < 40; x += 1) {
      words[x * PACKED_CELL_WORDS] = x === 8 ? 49 : 48
      words[x * PACKED_CELL_WORDS + 1] = 0xffffffff
      words[x * PACKED_CELL_WORDS + 2] = 0xffffffff
      words[x * PACKED_CELL_WORDS + 3] = 1
    }
    const packed = new PackedCells(words, new Uint32Array())
    const decode = vi.spyOn(packed, 'read')
    let materializations = 0
    let cells: readonly RenderCell[] | undefined
    source.rows[0] = {
      y: 0,
      dirty: true,
      packed,
      get cells() {
        if (!cells) {
          materializations += 1
          cells = packed.materialize()
        }
        return cells
      },
    }
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expect(materializations).toBe(0)
    expect(decode).toHaveBeenCalledTimes(40)
    expectFullRepaint(canvas, source)
  })

  it('does not rescan packed rows rejected during capture', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(
        0,
        Array.from({ length: 40 }, (_, x) => cell(x, { text: 'A' })),
      ),
    ])
    source.cursor.visible = false
    const renderer = await createRenderer(options(canvas, source, clock, { columns: 40, rows: 1 }))
    clock.flushFrame()
    expectFullRepaint(canvas, source)

    const words = new Uint32Array(40 * PACKED_CELL_WORDS)
    for (let x = 0; x < 40; x += 1) {
      words[x * PACKED_CELL_WORDS] = 65
      words[x * PACKED_CELL_WORDS + 1] = 0xffffffff
      words[x * PACKED_CELL_WORDS + 2] = 0xffffffff
      words[x * PACKED_CELL_WORDS + 3] = x === 39 ? 1 | 8 | (1 << 5) : 1
    }
    const packed = new PackedCells(words, new Uint32Array())
    const decode = vi.spyOn(packed, 'read')
    const materialize = vi.spyOn(packed, 'materialize')
    let cells: readonly RenderCell[] | undefined
    source.rows[0] = {
      y: 0,
      dirty: true,
      packed,
      get cells() {
        cells ??= packed.materialize()
        return cells
      },
    }
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expect(materialize).toHaveBeenCalledTimes(1)
    // One eligibility scan and one materialization for the fallback row key.
    expect(decode).toHaveBeenCalledTimes(80)
    expectFullRepaint(canvas, source)
  })

  it.each([
    { name: 'plain glyph', style: undefined, method: 'fillText' },
    { name: 'styled glyph', style: styled({ italic: true }), method: 'fillText' },
    { name: 'dashed underline', style: styled({ underline: 5 }), method: 'stroke' },
  ] as const)(
    'restores the row clip after a failed $name paint and repairs both rows',
    async ({ style, method }) => {
      const clock = new FakeClock()
      const canvas = createCanvas()
      const source = new FakeRenderState(
        Array.from({ length: 2 }, (_, y) =>
          row(
            y,
            Array.from({ length: 40 }, (_, x) => cell(x, { text: 'A', style })),
          ),
        ),
      )
      source.cursor.visible = false
      const renderer = await createRenderer(options(canvas, source, clock, { columns: 40 }))
      clock.flushFrame()
      expectFullRepaint(canvas, source)
      const before = { ...renderer.metrics }

      source.rows[0]!.cells[8]!.text = 'B'
      source.dirtyRow(0)
      renderer.notifyWrite()
      clock.flushFrame()
      expectFullRepaint(canvas, source)

      source.rows[0]!.cells[8]!.text = 'D'
      source.dirtyRow(0)
      const fault = vi
        .spyOn(CanvasRenderingContext2D.prototype, method)
        .mockImplementationOnce(() => {
          throw new TypeError('Injected row paint failure')
        })
      renderer.notifyWrite()
      expect(() => clock.flushFrame()).toThrow('Injected row paint failure')
      expect(source.acknowledgements).toBe(2)
      expect(renderer.metrics.submittedFrames).toBe(before.submittedFrames + 1)
      fault.mockRestore()

      source.rows[1]!.cells[8]!.text = 'C'
      source.dirtyRow(1)
      renderer.notifyWrite()
      clock.flushFrame()
      expect(source.acknowledgements).toBe(3)
      expect(renderer.metrics.submittedFrames).toBe(before.submittedFrames + 2)
      expectFullRepaint(canvas, source)
    },
  )

  it.each(['fill-text', 'pixels'] as const)(
    'discards a failed background batch before repainting another row in %s mode',
    async (mode) => {
      const clock = new FakeClock()
      const canvas = createCanvas()
      const source = new FakeRenderState([
        row(
          0,
          Array.from({ length: 40 }, (_, x) => cell(x, { text: 'A' })),
        ),
        row(
          1,
          Array.from({ length: 40 }, (_, x) =>
            cell(x, { text: 'A', background: { r: 0, g: 0, b: 255 } }),
          ),
        ),
      ])
      source.cursor.visible = false
      const renderer = await createRenderer(options(canvas, source, clock, { columns: 40 }), mode)
      clock.flushFrame()
      expectFullRepaint(canvas, source)
      const before = { ...renderer.metrics }

      source.rows[1]!.cells[8]!.text = 'B'
      source.dirtyRow(1)
      const fault = vi
        .spyOn(CanvasRenderingContext2D.prototype, 'fillRect')
        .mockImplementationOnce(() => {
          throw new TypeError('Injected background batch failure')
        })
      renderer.notifyWrite()
      expect(() => clock.flushFrame()).toThrow('Injected background batch failure')
      expect(source.acknowledgements).toBe(1)
      expect(renderer.metrics.submittedFrames).toBe(before.submittedFrames)
      fault.mockRestore()

      source.rows[0]!.cells[8]!.text = 'C'
      source.dirtyRow(0)
      renderer.notifyWrite()
      clock.flushFrame()
      expect(source.acknowledgements).toBe(2)
      expect(renderer.metrics.submittedFrames).toBe(before.submittedFrames + 1)
      expectFullRepaint(canvas, source)
      expect(pixel(canvas, 1, 1)).toEqual([0, 0, 0, 0])
    },
  )

  it('repairs identical direct painter retries after a glyph failure', () => {
    const canvas = createCanvas()
    canvas.width = 400
    canvas.height = 40
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: false })!
    const painter = new CanvasRowPainter(
      context,
      fittedFont(),
      canonicalRendererTheme(mergeRendererTheme({})),
    )
    painter.resetContext(fittedFont())
    const source = new FakeRenderState([
      row(
        0,
        Array.from({ length: 40 }, (_, x) => cell(x, { text: 'A' })),
      ),
    ])
    source.cursor.visible = false
    painter.paint(source.rows[0]!, undefined, canvas.width)
    expectFullRepaint(canvas, source)

    source.rows[0]!.cells[8]!.text = 'B'
    painter.paint(source.rows[0]!, undefined, canvas.width)
    expectFullRepaint(canvas, source)
    source.rows[0]!.cells[8]!.text = 'C'
    const fault = vi.spyOn(context, 'fillText').mockImplementationOnce(() => {
      throw new TypeError('Injected direct painter failure')
    })
    expect(() => painter.paint(source.rows[0]!, undefined, canvas.width)).toThrow(
      'Injected direct painter failure',
    )
    fault.mockRestore()
    painter.paint(source.rows[0]!, undefined, canvas.width)
    expectFullRepaint(canvas, source)
  })

  it('keeps bulk plain-text updates on the full-row painter', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState(
      Array.from({ length: 2 }, (_, y) =>
        row(
          y,
          Array.from({ length: 40 }, (_, x) => cell(x, { text: '0' })),
        ),
      ),
    )
    source.cursor.visible = false
    const renderer = await createRenderer(options(canvas, source, clock, { columns: 40 }))
    clock.flushFrame()
    const fillText = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText')
    for (const target of source.rows) {
      target.cells[39]!.text = '1'
      source.dirtyRow(target.y)
    }
    renderer.notifyWrite()
    clock.flushFrame()
    const glyphs = fillText.mock.calls.length
    expectFullRepaint(canvas, source)
    expect(glyphs).toBe(80)
  })

  it('remeasures late font ink after resource invalidation with unchanged geometry', async () => {
    const base = fittedFont()
    const font: TerminalFittedFont = {
      ...base,
      deviceBaseline: 24,
      deviceCellHeight: 30,
      deviceCellWidth: 15,
      deviceCharHeight: 24,
      deviceCharWidth: 15,
      pixelRatio: 1.5,
      settings: { ...base.settings, family: 'CanvasLateWide, monospace' },
    }
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState(
      Array.from({ length: 2 }, (_, y) =>
        row(
          y,
          Array.from({ length: 20 }, (_, x) => cell(x, { text: x === 10 ? 'W' : ' ' })),
        ),
      ),
    )
    source.cursor.visible = false
    const renderer = await createRenderer(options(canvas, source, clock, { columns: 20, font }))
    clock.flushFrame()
    expectFullRepaint(canvas, source, font)
    const context = canvas.getContext('2d')!
    const beforeM = context.measureText('M').width
    const beforeMg = context.measureText('Mg')
    const beforeW = context.measureText('W')
    const url = new URL('./tests/fixtures/late-wide.ttf', import.meta.url).href
    const face = new FontFace('CanvasLateWide', `url(${url})`, { unicodeRange: 'U+0057' })
    document.fonts.add(await face.load())
    resourceCleanups.add(() => document.fonts.delete(face))
    expect(context.measureText('M').width).toBe(beforeM)
    const afterMg = context.measureText('Mg')
    for (const key of [
      'fontBoundingBoxAscent',
      'fontBoundingBoxDescent',
      'actualBoundingBoxAscent',
      'actualBoundingBoxDescent',
    ] as const)
      expect(afterMg[key]).toBe(beforeMg[key])
    const afterW = context.measureText('W')
    expect(afterW.actualBoundingBoxLeft + afterW.actualBoundingBoxRight).toBeGreaterThan(
      beforeW.actualBoundingBoxLeft + beforeW.actualBoundingBoxRight,
    )
    renderer.setFont({ ...font, settings: { ...font.settings } })
    renderer.clearTextureAtlas()
    clock.flushFrame()
    expectFullRepaint(canvas, source, font)
    source.rows[0]!.cells[1]!.text = 'a'
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expectFullRepaint(canvas, source, font)
    source.rows[0]!.cells[10]!.text = ''
    source.dirtyRow(0)
    renderer.notifyWrite()
    clock.flushFrame()
    expectFullRepaint(canvas, source, font)
  })

  it('keeps alternating single-row edits intact on row-scratch pixel targets', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState(
      Array.from({ length: 2 }, (_, y) =>
        row(
          y,
          Array.from({ length: 20 }, (_, x) => cell(x, { text: y === 0 ? 'A' : 'B' })),
        ),
      ),
    )
    source.cursor.visible = false
    const renderer = await createRenderer(options(canvas, source, clock, { columns: 20 }), 'pixels')
    clock.flushFrame()
    expectFullRepaint(canvas, source)
    for (const [y, x, text] of [
      [0, 1, 'C'],
      [1, 18, 'D'],
      [0, 2, 'E'],
    ] as const) {
      source.rows[y]!.cells[x]!.text = text
      source.dirtyRow(y)
      renderer.notifyWrite()
      clock.flushFrame()
      expectFullRepaint(canvas, source)
    }
  })

  it('bounds cursor-only movement, style and visibility damage to cursor cells', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(
        0,
        Array.from({ length: 80 }, (_, x) => cell(x, { text: 'A' })),
      ),
    ])
    source.cursor.viewport = { wideTail: false, x: 3, y: 0 }
    const renderer = await createRenderer(options(canvas, source, clock, { columns: 80, rows: 1 }))
    clock.flushFrame()
    expectFullRepaint(canvas, source)
    const context = canvas.getContext('2d')!
    const clear = vi.spyOn(context, 'clearRect')
    const fill = vi.spyOn(context, 'fillText')
    source.cursor.viewport = { wideTail: false, x: 4, y: 0 }
    for (const cursor of [
      { visible: true, style: 'block' },
      { visible: false, style: 'block' },
      { visible: true, style: 'block' },
      { visible: true, style: 'bar' },
      { visible: true, style: 'underline' },
      { visible: true, style: 'outline' },
    ] as const) {
      clear.mockClear()
      fill.mockClear()
      source.cursor.visible = cursor.visible
      source.cursor.style = cursor.style
      source.dirtyRow(0)
      renderer.notifyWrite()
      clock.flushFrame()
      expectFullRepaint(canvas, source)
      expect(Math.max(...clear.mock.calls.map((call) => call[2]))).toBeLessThan(60)
      expect(fill.mock.calls.length).toBeLessThan(6)
    }
  })

  it('keeps plain damage pixels for contrast, empty cells and every cursor shape', async () => {
    const clock = new FakeClock()
    const canvas = createCanvas()
    const source = new FakeRenderState([
      row(
        0,
        Array.from({ length: 40 }, (_, x) => cell(x, { text: '0' })),
      ),
    ])
    const themeValues = {
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 100, g: 100, b: 100 },
      cursor: { r: 20, g: 20, b: 20 },
      cursorText: { r: 60, g: 60, b: 60 },
      minimumContrast: 21,
    }
    const theme = canonicalRendererTheme(mergeRendererTheme(themeValues))
    source.cursor.viewport = { wideTail: false, x: 8, y: 0 }
    const renderer = await createRenderer(
      options(canvas, source, clock, { columns: 40, rows: 1, theme: themeValues }),
    )
    clock.flushFrame()
    for (const [style, text] of [
      ['block', ''],
      ['bar', ' '],
      ['underline', 'B'],
      ['outline', '0'],
    ] as const) {
      source.cursor.style = style
      source.rows[0]!.cells[8]!.text = text
      source.dirtyRow(0)
      renderer.notifyWrite()
      clock.flushFrame()
      expectFullRepaint(canvas, source, fittedFont(), theme)
    }
  })

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

    expect(readRows).toHaveBeenCalledExactlyOnceWith({ rows: new Set([0, 1]), packed: true })
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

  it.each(['fill-text', 'pixels'] as const)(
    'keeps unscheduled clean rows intact for legacy viewport reads (%s)',
    async (mode) => {
      const clock = new FakeClock()
      const canvas = createCanvas()
      const source = new FakeRenderState(
        Array.from({ length: 10 }, (_, y) =>
          row(y, [cell(0, { background: { r: y + 1, g: 0, b: 0 } })]),
        ),
      )
      source.cursor.viewport = { x: 0, y: 9, wideTail: false }
      const legacySource: RenderStateSource = {
        update: () => source.update(),
        readCursor: () => source.readCursor(),
        readRows: (options) => source.readRows({ dirtyOnly: options?.dirtyOnly }),
        acknowledge: () => source.acknowledge(),
      }
      const reads = vi.spyOn(legacySource, 'readRows')
      const updates = vi.spyOn(legacySource, 'update')
      const renderer = await createRenderer(
        options(canvas, legacySource, clock, { columns: 1, rows: 10 }),
        mode,
      )
      expect(renderer.canvasPaintMode).toBe(mode)
      renderer.setFocused(true)
      clock.flushFrame()
      expect(pixel(canvas, 2, 142), 'known-good initial clean row').toEqual([8, 0, 0, 255])
      expectFullRepaint(canvas, source)
      const copy = vi.spyOn(canvas.getContext('2d')!, 'drawImage')
      reads.mockClear()
      updates.mockClear()
      const before = { ...renderer.metrics }
      for (let y = 0; y < 6; y++) {
        source.rows[y]!.cells = source.rows[y + 1]!.cells
        source.dirtyRow(y)
      }
      source.rows[6]!.cells = [cell(0, { background: { r: 99, g: 0, b: 0 } })]
      source.dirtyRow(6)
      source.cursor.style = 'underline'
      renderer.notifyWrite()
      clock.flushFrame()
      expect(pixel(canvas, 2, 142), 'clean row 7 keeps its unshifted background').toEqual([
        8, 0, 0, 255,
      ])
      expect(pixel(canvas, 2, 162)).toEqual([9, 0, 0, 255])
      expectFullRepaint(canvas, source)
      expect(copy).not.toHaveBeenCalled()
      expect(updates).toHaveBeenCalledOnce()
      expect(reads.mock.calls).toEqual([
        [{ dirtyOnly: true, packed: mode === 'fill-text' }],
        [{ rows: new Set([9]), packed: mode === 'fill-text' }],
      ])
      expect(reads.mock.results[1]?.value).toEqual(source.rows)
      expect(renderer.metrics.repaintedRows - before.repaintedRows).toBe(8)
      expect(renderer.metrics.paintedRows - before.paintedRows).toBe(8)
      expect(source.acknowledgements).toBe(2)
      expect(renderer.hasPendingFrame).toBe(false)
    },
  )

  it.each(['fill-text', 'pixels'] as const)(
    'commits consecutive cursor-only frames for legacy membership (%s)',
    async (mode) => {
      const clock = new FakeClock()
      const canvas = createCanvas()
      const source = new FakeRenderState(
        Array.from({ length: 10 }, (_, y) =>
          row(y, [cell(0, { background: { r: y + 1, g: 0, b: 0 } })]),
        ),
      )
      source.cursor.viewport = { x: 0, y: 9, wideTail: false }
      const legacySource: RenderStateSource = {
        update: () => source.update(),
        readCursor: () => source.readCursor(),
        readRows: (options) => source.readRows({ dirtyOnly: options?.dirtyOnly }),
        acknowledge: () => source.acknowledge(),
      }
      const reads = vi.spyOn(legacySource, 'readRows')
      const updates = vi.spyOn(legacySource, 'update')
      const renderer = await createRenderer(
        options(canvas, legacySource, clock, { columns: 1, rows: 10 }),
        mode,
      )
      expect(renderer.canvasPaintMode).toBe(mode)
      renderer.setFocused(true)
      clock.flushFrame()
      expectFullRepaint(canvas, source)
      for (const y of [8, 9, 8, 9]) {
        reads.mockClear()
        updates.mockClear()
        source.cursor.viewport = { x: 0, y, wideTail: false }
        renderer.notifyWrite()
        clock.flushFrame()
        expectFullRepaint(canvas, source)
        expect(updates).toHaveBeenCalledOnce()
        expect(reads).toHaveBeenCalledExactlyOnceWith({
          rows: new Set([8, 9]),
          packed: mode === 'fill-text',
        })
        expect(reads.mock.results[0]?.value).toEqual(source.rows)
      }
      source.cursor.visible = false
      renderer.notifyWrite()
      clock.flushFrame()
      expectFullRepaint(canvas, source)
      expect(pixel(canvas, 2, 182)).toEqual([10, 0, 0, 255])
      expect(source.acknowledgements).toBe(1)
      expect(renderer.hasPendingFrame).toBe(false)
    },
  )

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
    vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText').mockImplementation(function (
      this: CanvasRenderingContext2D,
      text,
      x,
      y,
    ) {
      glyphs.push({ alpha: this.globalAlpha, font: this.font, text, x })
      original.call(this, text, x, y)
    })
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
    vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText').mockImplementation(function (
      this: CanvasRenderingContext2D,
      text,
      x,
      y,
    ) {
      glyphColors.push(String(this.fillStyle))
      original.call(this, text, x, y)
    })
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
    stubRendererNavigator({ platform: 'MacIntel', userAgent: '' })
    const canvas = createCanvas()
    const getContext = canvas.getContext.bind(canvas)
    Object.defineProperty(canvas, 'getContext', {
      configurable: true,
      value: (type: string) => (type === '2d' ? getContext('2d') : null),
    })
    const clock = new FakeClock()
    const source = new FakeRenderState([row(0, [cell(0), cell(1)]), row(1, [cell(0), cell(1)])])
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new TypeError('WebGPU adapter unavailable')
    const device = await adapter.requestDevice()
    const destroy = vi.spyOn(device, 'destroy')
    const renderer = await createCompatibleTerminalRenderer({
      ...options(canvas, source, clock),
      deviceFactory: () => Promise.resolve(device),
    })

    expect(renderer.backend).toBe('canvas2d')
    expect(destroy).toHaveBeenCalledOnce()
    await device.lost
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
    stubRendererNavigator({ platform: 'MacIntel', userAgent: '' })
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

  it('does not hide Linux WebGL programming failures behind the fallback', async () => {
    stubRendererNavigator({ platform: 'Linux x86_64', userAgent: '' })
    const canvas = createCanvas()
    const getContext = vi.spyOn(canvas, 'getContext')
    const clock = new FakeClock()
    const source = new FakeRenderState([row(0, [cell(0), cell(1)]), row(1, [cell(0), cell(1)])])
    const deviceFactory = vi.fn(() =>
      Promise.reject(new WebGpuUnavailableError('adapter', 'No supported adapter')),
    )
    vi.spyOn(WebGL2RenderingContext.prototype, 'getShaderParameter').mockReturnValue(false)

    await expect(
      createCompatibleTerminalRenderer({
        ...options(canvas, source, clock),
        deviceFactory,
      }),
    ).rejects.toThrow('WebGL shader compilation failed')
    expect(deviceFactory).not.toHaveBeenCalled()
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2'])
  })
})

describe('Canvas alpha reference witnesses', () => {
  it('distinguishes actual transparent source-over from the sealed opaque scalar rule', () => {
    const canvas = createCanvas()
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: false })!
    context.fillStyle = 'red'
    context.globalAlpha = 0.5
    context.fillRect(0, 0, 1, 1)
    expect(pixel(canvas, 0, 0)).toEqual([255, 0, 0, 128])
    expect(pixel(canvas, 0, 0)).not.toEqual([128, 0, 127, 255])
    context.globalAlpha = 1
    context.fillStyle = 'rgba(0, 0, 255, 0.5)'
    context.fillRect(0, 0, 1, 1)
    const composed = context.getImageData(0, 0, 1, 1)
    const destination = createCanvas()
    destination.width = 1
    destination.height = 1
    destination
      .getContext('2d', { alpha: true, willReadFrequently: false })!
      .putImageData(composed, 0, 0)
    expect(pixel(destination, 0, 0)).toEqual(pixel(canvas, 0, 0))
    console.info(
      JSON.stringify({
        proof: 'transparent ordered source-over witness',
        rgba: pixel(canvas, 0, 0),
      }),
    )
  })

  it('does not assume glyph coverage is brush independent or separately rounded terms commute', () => {
    const canvas = createCanvas()
    canvas.width = 80
    canvas.height = 30
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: false })!
    context.font = '20px monospace'
    const raster = (brush: string) => {
      context.clearRect(0, 0, 80, 30)
      context.fillStyle = brush
      context.fillText('Ag', 1.5, 22)
      return context.getImageData(0, 0, 80, 30).data
    }
    const white = raster('white')
    const red = raster('red')
    let alphaDifference = 0
    for (let index = 3; index < white.length; index += 4)
      alphaDifference += Number(white[index] !== red[index])
    const output = createCanvas()
    output.width = 80
    output.height = 30
    const target = new ReferenceTarget(
      output,
      output.getContext('2d', { alpha: true, willReadFrequently: false })!,
    )
    resourceCleanups.add(() => target.dispose())
    target.resize(80, 30, 30)
    target.context.font = '20px monospace'
    for (const brush of ['white', 'red']) {
      target.beginRow(0)
      target.context.clearRect(0, 0, 80, 30)
      target.context.fillStyle = brush
      target.context.fillText('Ag', 1.5, 22)
      target.finishRow(0)
      target.present()
      const actual = output.getContext('2d')!.getImageData(0, 0, 80, 30).data
      expect(actual).toEqual(brush === 'white' ? white : red)
    }
    const combined = Math.floor((1 * 1 + 128 * 254 + 127) / 255)
    const split = Math.floor((1 * 1 + 127) / 255) + Math.floor((128 * 254 + 127) / 255)
    expect(combined).toBe(128)
    expect(split).toBe(127)
    console.info(
      JSON.stringify({
        proof: 'brush-specific coverage and rounding witness',
        alphaDifference,
        combined,
        split,
      }),
    )
  })
})

describe('Canvas pixel storage and failed presentation', () => {
  it('retains native transparent source-over rounding and bounds hostile output state', () => {
    const canvas = createCanvas()
    canvas.width = 2
    canvas.height = 2
    const output = canvas.getContext('2d', { alpha: true, willReadFrequently: false })!
    const target = new ReferenceTarget(canvas, output)
    resourceCleanups.add(() => target.dispose())
    target.resize(2, 2, 1)
    target.beginRow(0)
    target.context.fillStyle = 'rgba(255, 0, 0, 0.5)'
    target.context.fillRect(0, 0, 1, 1)
    target.context.fillStyle = 'rgba(0, 0, 255, 0.5)'
    target.context.fillRect(0, 0, 1, 1)
    target.finishRow(0)
    const raw = [...target.context.getImageData(0, 0, 1, 1).data]
    output.globalAlpha = 0
    output.setTransform(3, 0, 0, 3, 100, 100)
    output.beginPath()
    output.rect(0, 0, 0, 0)
    output.clip()
    target.present()
    expect(pixel(canvas, 0, 0)).toEqual(raw)
    expect(pixel(canvas, 1, 0)).toEqual([0, 0, 0, 0])
    expect(pixel(canvas, 0, 1)).toEqual([0, 0, 0, 0])
    expect(raw[3]).toBeLessThan(255)
    expect(target.metrics).toMatchObject({
      uploadedRegions: 1,
      uploadedPixelBytes: 8,
      rowCopyBytes: 8,
    })
  })

  it('reuses one ImageData view until resize and keeps cumulative work after disposal', () => {
    const canvas = createCanvas()
    const source = new FakeRenderState([row(0, [cell(0)])])
    source.cursor.visible = false
    const clock = new FakeClock()
    return createRenderer(options(canvas, source, clock, { columns: 1, rows: 1 }), 'pixels').then(
      (renderer) => {
        const upload = vi.spyOn(canvas.getContext('2d')!, 'putImageData')
        clock.flushFrame()
        const initial = upload.mock.calls[0]![0]
        source.rows[0]!.cells = [cell(0, { text: 'Ag' })]
        source.dirtyRow(0)
        renderer.notifyWrite()
        clock.flushFrame()
        expect(upload.mock.calls[1]![0]).toBe(initial)
        renderer.setFont({ ...fittedFont(), deviceCellWidth: 11 })
        clock.flushFrame()
        const resized = upload.mock.calls[2]![0]
        expect(resized).not.toBe(initial)
        expect(resized.width).toBe(11)
        expect(initial.width).toBe(10)
        const before = { ...renderer.metrics }
        renderer.dispose()
        renderer.schedule()
        expect(clock.frames.size).toBe(0)
        expect(renderer.metrics).toEqual(before)
      },
    )
  })

  it('retains sparse pending uploads after failure and acknowledges only the repaired frame', async () => {
    const canvas = createCanvas()
    const source = new FakeRenderState(
      Array.from({ length: 3 }, (_, y) =>
        row(y, [cell(0, { background: { r: 10 + y, g: 0, b: 0 } })]),
      ),
    )
    source.cursor.visible = false
    const clock = new FakeClock()
    const renderer = await createRenderer(
      options(canvas, source, clock, { columns: 1, rows: 3 }),
      'pixels',
    )
    clock.flushFrame()
    const before = { ...renderer.metrics }
    const context = canvas.getContext('2d')!
    const original = context.putImageData.bind(context)
    const upload = vi.spyOn(context, 'putImageData')
    upload.mockImplementationOnce((...args) => original(...args))
    upload.mockImplementationOnce(() => {
      throw new TypeError('Injected pixel upload failure')
    })
    for (const y of [0, 2]) {
      source.rows[y]!.cells = [cell(0, { background: { r: 30 + y, g: 0, b: 0 } })]
      source.dirtyRow(y)
    }
    renderer.notifyWrite()
    expect(() => clock.flushFrame()).toThrow('Injected pixel upload failure')
    expect(source.acknowledgements).toBe(1)
    expect(renderer.metrics.submittedFrames).toBe(before.submittedFrames)
    expect(renderer.metrics.uploadedRegions - before.uploadedRegions).toBe(1)
    expect(pixel(canvas, 2, 42)).toEqual([12, 0, 0, 255])
    renderer.notifyWrite()
    clock.flushFrame()
    expect(source.acknowledgements).toBe(2)
    expect(renderer.metrics.submittedFrames).toBe(before.submittedFrames + 1)
    expect(renderer.metrics.uploadedRegions - before.uploadedRegions).toBe(3)
    expectFullRepaint(canvas, source)
    expect(upload.mock.calls.map((call) => call.slice(3))).toEqual([
      [0, 0, 10, 20],
      [0, 40, 10, 20],
      [0, 0, 10, 20],
      [0, 40, 10, 20],
    ])
  })
})
