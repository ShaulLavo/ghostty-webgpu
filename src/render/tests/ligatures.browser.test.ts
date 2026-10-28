/// <reference types="vite/client" />
import woffUrl from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff?url'
import notoFontUrl from '../../../bench/fixtures/correctness/NotoSansMono-Regular.ttf?url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import { GhosttySelectionGesture } from '../../core/selection.js'
import type { GhosttyRenderState } from '../../core/render-state.js'
import type { GhosttyTerminal } from '../../core/terminal.js'
import type { RenderCell, RenderRow, RgbColor } from '../../core/types.js'
import { testFontUrl } from '../../tests/fonts.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { CanvasTerminalRenderer } from '../canvas/renderer.js'
import { DomTerminalRenderer } from '../dom/renderer.js'
import { CanvasGlyphRasterizer } from '../shared/atlas/canvas-rasterizer.js'
import type { GlyphBitmap, GlyphRasterizationInput } from '../shared/atlas/types.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../shared/config.js'
import type { CanonicalRendererTheme } from '../shared/instances/types.js'
import {
  createProbeLigatureFinder,
  loadGsubLigatureFinder,
  type LigatureFinder,
  type LigatureRange,
} from '../shared/ligatures/finder.js'
import { ligatureRuns } from '../shared/ligatures/runs.js'
import type { WebGpuTerminalRendererOptions } from '../shared/types.js'
import { WebGlTerminalRenderer } from '../webgl/renderer.js'
import { displayedPixels, fittedFont, TestClock } from '../webgl/tests/fixture.js'
import { WebGpuTerminalRenderer } from '../webgpu/renderer.js'

type Backend = 'webgpu' | 'webgl2' | 'canvas2d-fill-text' | 'canvas2d-pixels' | 'dom'
interface Renderer {
  dispose(): void
  notifySelectionChange(): void
  notifyWrite(): void
  setFocused(focused: boolean): void
}

const fixtures = import.meta.glob<string>('../../../bench/fixtures/correctness/ligature-*.vt', {
  eager: true,
  import: 'default',
  query: '?raw',
})
const notoUrl = new URL(notoFontUrl, import.meta.url).href
const ligatureFace = new FontFace('Ligature Test', `url(${testFontUrl})`)
const notoFace = new FontFace('Ligature Noto Test', `url(${notoUrl})`)
const theme: CanonicalRendererTheme = canonicalRendererTheme(mergeRendererTheme({}))
const disposables: (() => void)[] = []
const viewport = { width: window.innerWidth, height: window.innerHeight }
let jetBrains: LigatureFinder
let noto: LigatureFinder
let webgpu = false
let webglInk = true

beforeAll(async () => {
  await page.viewport(1400, 1000)
  document.fonts.add(await ligatureFace.load())
  document.fonts.add(await notoFace.load())
  jetBrains = await loadGsubLigatureFinder(new URL(woffUrl, import.meta.url))
  noto = await loadGsubLigatureFinder(notoUrl)
  webgpu = Boolean(await navigator.gpu?.requestAdapter())
  webglInk = await webglScreenshotsShowInk()
})

// Headless WebKit on Linux captures WebGL2 canvases without glyph ink, on main as well.
async function webglScreenshotsShowInk(): Promise<boolean> {
  const mounted = await mount('webgl2', 'abc', testFont(16, 24, 20, '"Ligature Test"'), undefined)
  const pixels = await displayedPixels(mounted.canvas)
  for (const dispose of disposables.splice(0).reverse()) dispose()
  const { r, g, b } = theme.background
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] !== r || pixels[index + 1] !== g || pixels[index + 2] !== b) return true
  }
  return false
}

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
})

afterAll(async () => {
  document.fonts.delete(ligatureFace)
  document.fonts.delete(notoFace)
  await page.viewport(viewport.width, viewport.height)
})

async function fixture(name: string): Promise<string> {
  const content = fixtures[`../../../bench/fixtures/correctness/${name}`]
  if (content === undefined) throw new Error(`Missing fixture ${name}`)
  return content
}

function testFont(width: number, height: number, size: number, family: string) {
  const font = fittedFont(width, height, size)
  return { ...font, settings: { ...font.settings, family } }
}

interface Mounted {
  backend: Backend
  canvas: HTMLCanvasElement
  clock: TestClock
  font: TerminalFittedFont
  renderer: Renderer
  state: GhosttyRenderState
  terminal: GhosttyTerminal
}

async function createRenderer(backend: Backend, options: WebGpuTerminalRendererOptions) {
  if (backend === 'webgpu') return WebGpuTerminalRenderer.create(options)
  if (backend === 'webgl2') return WebGlTerminalRenderer.create(options)
  if (backend === 'dom') return DomTerminalRenderer.create(options)
  return CanvasTerminalRenderer.create({ ...options, rendererMode: backend })
}

async function mount(
  backend: Backend,
  content: string,
  font: TerminalFittedFont,
  ligatures: LigatureFinder | undefined,
  columns = 40,
  rows = 8,
): Promise<Mounted> {
  const runtime = await GhosttyRuntime.create()
  disposables.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns, rows })
  const state = runtime.createRenderState(terminal)
  terminal.write(content)
  const host = document.createElement('div')
  host.style.position = 'relative'
  const canvas = document.createElement('canvas')
  canvas.style.backgroundColor = css(theme.background)
  canvas.style.display = 'block'
  host.append(canvas)
  document.body.append(host)
  disposables.push(() => host.remove())
  const clock = new TestClock()
  const renderer = await createRenderer(backend, {
    canvas,
    columns,
    rows,
    font,
    ligatures,
    renderState: state,
    schedulerClock: clock,
  })
  disposables.push(() => {
    renderer.dispose()
    if (backend === 'webgl2')
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
  })
  renderer.setFocused(true)
  const mounted = { backend, canvas, clock, font, renderer, state, terminal }
  flush(mounted)
  return mounted
}

function flush(mounted: Mounted): void {
  for (let attempt = 0; attempt < 8 && mounted.clock.frames.size > 0; attempt += 1)
    mounted.clock.flushFrame()
  expect(mounted.clock.frames.size).toBe(0)
}

function update(mounted: Mounted, write?: string): void {
  if (write) mounted.terminal.write(write)
  mounted.renderer.notifyWrite()
  flush(mounted)
}

function logicalRows(mounted: Mounted): readonly RenderRow[] {
  return Array.from(mounted.state.readRows(), (row) => ({
    ...row,
    cells: Array.from(row.cells, (cell) => ({ ...cell })),
  }))
}

function rowText(row: RenderRow): string {
  return row.cells
    .map((cell) => (cell.continuation ? '' : cell.text || ' '))
    .join('')
    .trimEnd()
}

function cursorOf(mounted: Mounted): { x: number; y: number } | undefined {
  const cursor = mounted.state.readCursor()
  if (!cursor.visible || !cursor.viewport) return undefined
  return { x: cursor.viewport.x, y: cursor.viewport.y }
}

function expectRuns(mounted: Mounted, finder: LigatureFinder, expected: LigatureRange[][]): void {
  const cursor = cursorOf(mounted)
  const rows = logicalRows(mounted)
  for (const [y, ranges] of expected.entries()) {
    const column = cursor?.y === y ? cursor.x : undefined
    expect(ligatureRuns(rows[y]!.cells, finder, column), `row ${y} ranges`).toEqual(ranges)
  }
}

function cellColors(
  cell: RenderCell,
  cursor: boolean,
): { foreground: RgbColor; background: RgbColor } {
  if (cursor) return { foreground: theme.cursorText, background: theme.cursor }
  if (cell.selected)
    return { foreground: theme.selectionForeground, background: theme.selectionBackground }
  const foreground = cell.foreground ?? theme.foreground
  const background = cell.background ?? theme.background
  if (cell.style?.inverse) return { foreground: background, background: foreground }
  return { foreground, background }
}

function css(color: RgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

// An explicit Canvas2D drawing of the expected runs, independent of the run finder.
function oracle(mounted: Mounted, expected: LigatureRange[][]): Uint8ClampedArray {
  const { canvas, font } = mounted
  const reference = document.createElement('canvas')
  reference.width = canvas.width
  reference.height = canvas.height
  const context = reference.getContext('2d')!
  context.fillStyle = css(theme.background)
  context.fillRect(0, 0, reference.width, reference.height)
  const cursor = cursorOf(mounted)
  const rows = logicalRows(mounted)
  for (const row of rows) {
    for (const cell of row.cells) {
      const colors = cellColors(cell, cursor?.x === cell.x && cursor.y === row.y)
      context.fillStyle = css(colors.background)
      context.fillRect(
        cell.x * font.deviceCellWidth,
        row.y * font.deviceCellHeight,
        font.deviceCellWidth,
        font.deviceCellHeight,
      )
    }
  }
  const atlas = mounted.backend !== 'canvas2d-fill-text'
  for (const row of rows) {
    for (const glyph of oracleGlyphs(row, expected[row.y] ?? [], cursor))
      drawOracleGlyph(context, font, glyph, atlas)
  }
  return context.getImageData(0, 0, reference.width, reference.height).data
}

interface OracleGlyph {
  readonly bold: boolean
  readonly foreground: RgbColor
  readonly span: number
  readonly text: string
  readonly x: number
  readonly y: number
}

function oracleGlyphs(
  row: RenderRow,
  ranges: readonly LigatureRange[],
  cursor: { x: number; y: number } | undefined,
): OracleGlyph[] {
  const glyphs: OracleGlyph[] = []
  for (let index = 0; index < row.cells.length; index += 1) {
    const cell = row.cells[index]!
    if (cell.continuation || !cell.text) continue
    const range = ranges.find(([start]) => start === index)
    const span = range ? range[1] - range[0] : row.cells[index + 1]?.continuation ? 2 : 1
    const text = range
      ? row.cells
          .slice(range[0], range[1])
          .map((part) => part.text)
          .join('')
      : cell.text
    const colors = cellColors(cell, cursor?.x === cell.x && cursor.y === row.y)
    glyphs.push({
      bold: cell.style?.bold ?? false,
      foreground: colors.foreground,
      span,
      text,
      x: cell.x,
      y: row.y,
    })
    index += span - 1
  }
  return glyphs
}

// Atlas backends tint white coverage; direct Canvas text uses the brush's own text gamma.
function drawOracleGlyph(
  context: CanvasRenderingContext2D,
  font: TerminalFittedFont,
  glyph: OracleGlyph,
  atlas: boolean,
): void {
  const spacing = font.deviceCellWidth - font.deviceCharWidth
  const weight = glyph.bold ? font.settings.boldWeight : font.settings.weight
  const x =
    glyph.x * font.deviceCellWidth +
    font.charLeft +
    (font.deviceCellWidth * glyph.span - spacing) / 2
  const y = glyph.y * font.deviceCellHeight + font.deviceBaseline
  const ink = document.createElement('canvas')
  ink.width = context.canvas.width
  ink.height = context.canvas.height
  const inkContext = ink.getContext('2d', { willReadFrequently: true })!
  inkContext.font = `${weight} ${font.settings.size * font.pixelRatio}px ${font.settings.family}`
  inkContext.textAlign = 'center'
  inkContext.textBaseline = 'alphabetic'
  inkContext.fillStyle = atlas ? '#ffffff' : css(glyph.foreground)
  inkContext.fillText(glyph.text, x, y)
  if (atlas) {
    const image = inkContext.getImageData(0, 0, ink.width, ink.height)
    const intrinsic = image.data.some(
      (value, index) => index % 4 !== 3 && image.data[index - (index % 4) + 3]! > 0 && value < 253,
    )
    if (!intrinsic) {
      for (let index = 0; index < image.data.length; index += 4) {
        image.data[index] = glyph.foreground.r
        image.data[index + 1] = glyph.foreground.g
        image.data[index + 2] = glyph.foreground.b
      }
      inkContext.putImageData(image, 0, 0)
    }
  }
  context.drawImage(ink, 0, 0)
}

function pixelsCheckable(mounted: Mounted): boolean {
  if (mounted.backend === 'dom') return false
  return mounted.backend !== 'webgl2' || webglInk
}

async function capture(mounted: Mounted): Promise<Uint8Array> {
  return displayedPixels(mounted.canvas)
}

function differingPixels(
  actual: Uint8Array,
  expected: Uint8ClampedArray,
  rows: number,
  font: TerminalFittedFont,
  width: number,
): number {
  const limit = rows * font.deviceCellHeight * width * 4
  let count = 0
  for (let index = 0; index < limit; index += 1) {
    if (index % 4 === 3) continue
    if (Math.abs(actual[index]! - expected[index]!) > 2) count += 1
  }
  return count
}

async function expectPixels(mounted: Mounted, expected: LigatureRange[][]): Promise<void> {
  if (mounted.backend === 'dom') {
    expectDomRuns(mounted, expected)
    return
  }
  if (!pixelsCheckable(mounted)) return
  const actual = await capture(mounted)
  const reference = oracle(mounted, expected)
  const differences = differingPixels(
    actual,
    reference,
    expected.length,
    mounted.font,
    mounted.canvas.width,
  )
  let maximum = 0
  for (let index = 0; index < reference.length; index += 1)
    if (index % 4 !== 3) maximum = Math.max(maximum, Math.abs(actual[index]! - reference[index]!))
  expect(differences, `${mounted.backend} matches the explicit run oracle (max ${maximum})`).toBe(0)
}

function joinedSpans(mounted: Mounted): string[][] {
  const container = mounted.canvas.nextElementSibling!
  return Array.from(container.querySelectorAll('[data-row]'), (row) =>
    Array.from(row.querySelectorAll('span'))
      .filter((span) => span.style.fontVariantLigatures === 'normal')
      .map((span) => span.textContent ?? ''),
  )
}

function expectDomRuns(mounted: Mounted, expected: LigatureRange[][]): void {
  const rows = logicalRows(mounted)
  const spans = joinedSpans(mounted)
  for (const [y, ranges] of expected.entries()) {
    const texts = ranges.map(([start, end]) =>
      rows[y]!.cells.slice(start, end)
        .map((cell) => cell.text)
        .join(''),
    )
    expect(spans[y], `DOM row ${y} joined spans`).toEqual(texts)
  }
}

interface RasterRecord {
  readonly input: GlyphRasterizationInput
  readonly bitmap: GlyphBitmap | undefined
}

function recordRasterInputs(): RasterRecord[] {
  const records: RasterRecord[] = []
  const rasterize = CanvasGlyphRasterizer.prototype.rasterize
  vi.spyOn(CanvasGlyphRasterizer.prototype, 'rasterize').mockImplementation(function (
    this: CanvasGlyphRasterizer,
    input,
  ) {
    const bitmap = rasterize.call(this, input)
    records.push({ input: { ...input }, bitmap })
    return bitmap
  })
  return records
}

function recordFillText(): string[] {
  const texts: string[] = []
  const fillText = CanvasRenderingContext2D.prototype.fillText
  vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText').mockImplementation(function (
    this: CanvasRenderingContext2D,
    text,
    x,
    y,
    maxWidth,
  ) {
    texts.push(text)
    if (maxWidth === undefined) fillText.call(this, text, x, y)
    else fillText.call(this, text, x, y, maxWidth)
  })
  return texts
}

// Raster inputs prove one multi-cell glyph per range and no per-cell glyph inside one.
function expectRasterInputs(
  backend: Backend,
  joined: string[],
  records: RasterRecord[],
  texts: string[],
) {
  if (backend === 'dom') return
  if (backend === 'canvas2d-fill-text') {
    const multi = texts.filter((text) => text.length > 1 && /^[\x21-\x7e]+$/.test(text))
    expect(new Set(multi)).toEqual(new Set(joined))
    return
  }
  const multi = records
    .filter((record) => record.input.cellSpan > 1 && /^[\x21-\x7e]+$/.test(record.input.text))
    .map((record) => `${record.input.text}:${record.input.cellSpan}`)
  expect(new Set(multi)).toEqual(new Set(joined.map((text) => `${text}:${text.length}`)))
}

const backends: Backend[] = ['webgpu', 'webgl2', 'canvas2d-fill-text', 'canvas2d-pixels', 'dom']
const scales = [
  { name: '1x', width: 16, height: 24, size: 20 },
  { name: '2x', width: 32, height: 48, size: 40 },
]

for (const backend of backends) {
  describe(`${backend} ligatures`, () => {
    const available = () => backend !== 'webgpu' || webgpu

    for (const scale of scales) {
      const font = () => testFont(scale.width, scale.height, scale.size, '"Ligature Test"')

      it(`joins programming ligatures at ${scale.name}`, async (context) => {
        if (!available()) context.skip()
        const records = recordRasterInputs()
        const texts = recordFillText()
        const mounted = await mount(
          backend,
          await fixture('ligature-programming.vt'),
          font(),
          jetBrains,
        )
        expect(rowText(logicalRows(mounted)[0]!)).toBe('=> != -> === <=>')
        const expected: LigatureRange[][] = [
          [
            [0, 2],
            [3, 5],
            [6, 8],
            [9, 12],
            [13, 16],
          ],
        ]
        expectRuns(mounted, jetBrains, expected)
        expectRasterInputs(backend, ['=>', '!=', '->', '===', '<=>'], records, texts)
        await expectPixels(mounted, expected)
      })

      it(`keeps fallback, wide and color glyphs out of runs at ${scale.name}`, async (context) => {
        if (!available()) context.skip()
        const fallback = await mount(
          backend,
          await fixture('ligature-fallback.vt'),
          font(),
          jetBrains,
        )
        const expected: LigatureRange[][] = [
          [
            [1, 3],
            [5, 7],
          ],
        ]
        expectRuns(fallback, jetBrains, expected)
        await expectPixels(fallback, expected)
        const wide = await mount(backend, await fixture('ligature-wide.vt'), font(), jetBrains)
        expect(logicalRows(wide)[0]!.cells[2]!.continuation).toBe(true)
        const wideExpected: LigatureRange[][] = [[[3, 5]], []]
        expectRuns(wide, jetBrains, wideExpected)
        await expectPixels(wide, wideExpected)
      })
    }

    for (const geometry of [
      { name: '16x24', width: 16, height: 24, size: 20 },
      { name: '13x27', width: 13, height: 27, size: 20 },
      { name: '26x54', width: 26, height: 54, size: 40 },
    ]) {
      it(`keeps overhanging ink of a three-cell run at ${geometry.name}`, async (context) => {
        if (!available()) context.skip()
        const font = testFont(geometry.width, geometry.height, geometry.size, '"Ligature Test"')
        const mounted = await mount(backend, await fixture('ligature-overhang.vt'), font, jetBrains)
        const expected: LigatureRange[][] = [[[1, 4]]]
        expectRuns(mounted, jetBrains, expected)
        await expectPixels(mounted, expected)
      })
    }

    it('splits a run only while the cursor is on one of its cells', async (context) => {
      if (!available()) context.skip()
      const font = testFont(16, 24, 20, '"Ligature Test"')
      const mounted = await mount(backend, await fixture('ligature-cursor.vt'), font, jetBrains)
      for (const [sequence, column, expected] of [
        ['', 1, []],
        ['\x1b[1;3H', 2, []],
        ['\x1b[1;1H', 0, [[1, 3]]],
        ['\x1b[1;4H', 3, [[1, 3]]],
        ['\x1b[1;2H', 1, []],
      ] as const) {
        update(mounted, sequence)
        expect(mounted.state.readCursor().viewport?.x).toBe(column)
        const ranges: LigatureRange[][] = [expected.map(([start, end]) => [start, end] as const)]
        expectRuns(mounted, jetBrains, ranges)
        await expectPixels(mounted, ranges)
      }
    })

    it('splits partial selections and rejoins after clearing', async (context) => {
      if (!available()) context.skip()
      const font = testFont(16, 24, 20, '"Ligature Test"')
      const mounted = await mount(backend, await fixture('ligature-selection.vt'), font, jetBrains)
      const gesture = new GhosttySelectionGesture(mounted.terminal)
      disposables.push(() => gesture.dispose())
      for (const [start, end, copied, expected] of [
        [1, 1, '=', []],
        [2, 2, '>', []],
        [1, 2, '=>', [[1, 3]]],
      ] as const) {
        gesture.selectRange({ x: start, y: 0 }, { x: end, y: 0 })
        mounted.renderer.notifySelectionChange()
        flush(mounted)
        expect(mounted.terminal.getSelection()).toBe(copied)
        const ranges: LigatureRange[][] = [expected.map(([first, last]) => [first, last] as const)]
        expectRuns(mounted, jetBrains, ranges)
        await expectPixels(mounted, ranges)
      }
      mounted.terminal.clearSelection()
      mounted.renderer.notifySelectionChange()
      flush(mounted)
      await expectPixels(mounted, [[[1, 3]]])
    })

    it('splits at foreground and weight changes and joins across a background change', async (context) => {
      if (!available()) context.skip()
      const font = testFont(16, 24, 20, '"Ligature Test"')
      const mounted = await mount(backend, await fixture('ligature-style.vt'), font, jetBrains)
      const rows = logicalRows(mounted)
      expect(rows[0]!.cells[2]!.foreground).toBeDefined()
      expect(rows[1]!.cells[2]!.style?.bold).toBe(true)
      expect(rows[2]!.cells[2]!.style?.underline).toBe(1)
      expect(rows[3]!.cells[2]!.background).toBeDefined()
      expectRuns(mounted, jetBrains, [[], [], [], [[1, 3]]])
      // Underline geometry belongs to each backend; row 2 is checked through its run topology.
      if (backend === 'dom') {
        expectDomRuns(mounted, [[], [], [], []])
        return
      }
      if (!pixelsCheckable(mounted)) return
      const actual = await capture(mounted)
      const reference = oracle(mounted, [[], [], [], [[1, 3]]])
      const rowBytes = mounted.canvas.width * font.deviceCellHeight * 4
      for (const y of [0, 1, 3]) {
        const slice = (pixels: ArrayLike<number>) =>
          Array.prototype.slice.call(pixels, y * rowBytes, (y + 1) * rowBytes) as number[]
        const actualRow = Uint8Array.from(slice(actual))
        const expectedRow = Uint8ClampedArray.from(slice(reference))
        expect(
          differingPixels(actualRow, expectedRow, 1, font, mounted.canvas.width),
          `row ${y}`,
        ).toBe(0)
      }
    })

    it('finds no runs in a font without joining features', async (context) => {
      if (!available()) context.skip()
      const font = testFont(16, 24, 20, '"Ligature Noto Test"')
      const mounted = await mount(
        backend,
        await fixture('ligature-no-ligature-font.vt'),
        font,
        noto,
      )
      expectRuns(mounted, noto, [[]])
      await expectPixels(mounted, [[]])
    })

    it('keeps fi, fl and st in separate cells', async (context) => {
      if (!available()) context.skip()
      const font = testFont(16, 24, 20, '"Ligature Test"')
      const mounted = await mount(
        backend,
        await fixture('ligature-latin-policy.vt'),
        font,
        jetBrains,
      )
      const expected: LigatureRange[][] = [[[16, 18]]]
      expectRuns(mounted, jetBrains, expected)
      await expectPixels(mounted, expected)
    })

    it('keeps color glyphs intrinsic beside joined runs', async (context) => {
      if (!available()) context.skip()
      const records = recordRasterInputs()
      const font = testFont(16, 24, 20, '"Ligature Test"')
      const mounted = await mount(backend, await fixture('ligature-color.vt'), font, jetBrains)
      const expected: LigatureRange[][] = [
        [
          [0, 2],
          [4, 6],
        ],
      ]
      expectRuns(mounted, jetBrains, expected)
      await expectPixels(mounted, expected)
      const runs = records.filter(
        (record) => record.input.cellSpan > 1 && record.input.text !== '🙂',
      )
      for (const record of runs) expect(record.bitmap?.kind, record.input.text).toBe('grayscale')
      const gesture = new GhosttySelectionGesture(mounted.terminal)
      disposables.push(() => gesture.dispose())
      gesture.selectRange({ x: 0, y: 0 }, { x: 5, y: 0 })
      mounted.renderer.notifySelectionChange()
      flush(mounted)
      expectRuns(mounted, jetBrains, expected)
      await expectPixels(mounted, expected)
    })

    it('draws the existing per-cell path when ligatures are off', async (context) => {
      if (!available()) context.skip()
      const font = testFont(16, 24, 20, '"Ligature Test"')
      const records = recordRasterInputs()
      const mounted = await mount(
        backend,
        await fixture('ligature-programming.vt'),
        font,
        undefined,
      )
      expect(records.some((record) => record.input.text.length > 1)).toBe(false)
      if (backend === 'dom') {
        expect(joinedSpans(mounted)[0]).toEqual([])
        return
      }
      if (!pixelsCheckable(mounted)) return
      const actual = await capture(mounted)
      expect(differingPixels(actual, oracle(mounted, [[]]), 1, font, mounted.canvas.width)).toBe(0)
    })
  })
}

describe('probe fallback without font bytes', () => {
  const codepoints = (text: string) => Array.from(text, (character) => character.codePointAt(0)!)

  it('confirms programming ligatures against the browser shaping of the face', () => {
    const finder = createProbeLigatureFinder(testFont(16, 24, 20, '"Ligature Test"'))
    expect(finder.find(codepoints('a=>b'))).toEqual([[1, 3]])
    expect(finder.find(codepoints('<=>'))).toEqual([[0, 3]])
    expect(finder.find(codepoints('office'))).toEqual([])
  })

  it('finds nothing in a face without joining features', () => {
    const finder = createProbeLigatureFinder(testFont(16, 24, 20, '"Ligature Noto Test"'))
    expect(finder.find(codepoints('=> != -> === <=>'))).toEqual([])
  })
})
