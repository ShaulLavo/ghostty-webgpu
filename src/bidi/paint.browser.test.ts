import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import mixed from '../../bench/fixtures/correctness/bidi-hebrew-mixed.vt?raw'
import numbers from '../../bench/fixtures/correctness/bidi-hebrew-numbers.vt?raw'
import punctuation from '../../bench/fixtures/correctness/bidi-hebrew-punctuation.vt?raw'
import arabic from '../../bench/fixtures/correctness/bidi-arabic.vt?raw'
import wide from '../../bench/fixtures/correctness/bidi-wide-emoji.vt?raw'
import cursor from '../../bench/fixtures/correctness/bidi-cursor.vt?raw'
import resize from '../../bench/fixtures/correctness/bidi-resize.vt?raw'
import { GhosttyRuntime } from '../core/runtime.js'
import type { RenderRow } from '../core/types.js'
import { CanvasTerminalRenderer } from '../render/canvas/renderer.js'
import type { GlyphBitmap } from '../render/shared/atlas/types.js'
import { CanvasGlyphRasterizer } from '../render/shared/atlas/canvas-rasterizer.js'
import { CanvasRowPainter } from '../render/canvas/painter.js'
import { DomTerminalRenderer } from '../render/dom/renderer.js'
import { WebGlTerminalRenderer } from '../render/webgl/renderer.js'
import { WebGpuTerminalRenderer } from '../render/webgpu/renderer.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../render/shared/config.js'
import type {
  WebGpuTerminalRendererOptions,
  RendererFrameSnapshot,
} from '../render/shared/types.js'
import { TestClock } from '../render/webgl/tests/fixture.js'
import { fittedFont } from '../render/canvas/tests/font.js'
import { testFontUrl } from '../tests/fonts.js'
import { RowBidiMapper } from './row.js'

const fixtures = [
  { name: 'mixed', input: mixed, map: [0, 1, 2, 6, 5, 4, 3, 7, 8, 9] },
  { name: 'numbers', input: numbers, map: [7, 6, 5, 3, 4, 2, 1, 0] },
  { name: 'punctuation', input: punctuation, map: [4, 3, 2, 1, 0] },
  { name: 'arabic', input: arabic, map: [5, 6, 7, 4, 3, 2, 1, 0] },
  { name: 'wide', input: wide, map: [0, 4, 2, 3, 1, 5] },
]
const cleanups: (() => void)[] = []
const font = new FontFace('BidiTest', `url(${testFontUrl})`)
const initialViewport = { width: window.innerWidth, height: window.innerHeight }
beforeAll(async () => {
  document.fonts.add(await font.load())
  await page.viewport(1800, 1000)
})
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
})
afterAll(async () => {
  document.fonts.delete(font)
  await page.viewport(initialViewport.width, initialViewport.height)
})

async function pixels(element: Element): Promise<Uint8Array> {
  const image = new Image()
  image.src = `data:image/png;base64,${await page.screenshot({ element, save: false, scale: 'css' })}`
  await image.decode()
  const bounds = element.getBoundingClientRect()
  expect(
    [image.naturalWidth, image.naturalHeight],
    'Screenshot matches the element geometry',
  ).toEqual([bounds.width, bounds.height])
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0)
  return new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data)
}

async function create(backend: string, ratio: number, input: string, columns = 40, enabled = true) {
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns, rows: 8 })
  const state = runtime.createRenderState(terminal)
  terminal.write(input)
  const host = document.createElement('div')
  host.style.cssText = 'position:relative;display:block;width:max-content;background:rgb(17,17,17)'
  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.backgroundColor = 'rgb(17,17,17)'
  host.append(canvas)
  document.body.append(host)
  cleanups.push(() => host.remove())
  const clock = new TestClock()
  const fitted = fittedFont(ratio)
  const font = { ...fitted, settings: { ...fitted.settings, family: '"BidiTest", monospace' } }
  const snapshots: RendererFrameSnapshot[] = []
  const options: WebGpuTerminalRendererOptions = {
    canvas,
    font,
    columns,
    rows: 8,
    renderState: state,
    schedulerClock: clock,
    bidi: enabled,
    rendererMode: backend === 'pixels' ? 'canvas2d-pixels' : undefined,
    onFrame: (snapshot) => snapshots.push(snapshot),
  }
  let renderer
  if (backend === 'webgpu') renderer = await WebGpuTerminalRenderer.create(options)
  else if (backend === 'webgl') renderer = await WebGlTerminalRenderer.create(options)
  else if (backend === 'dom') renderer = await DomTerminalRenderer.create(options)
  else renderer = await CanvasTerminalRenderer.create(options)
  cleanups.push(() => renderer.dispose())
  renderer.setFocused(true)
  clock.flushFrame()
  const element = backend === 'dom' ? host.querySelector('.ghostty-webgpu-frame')! : canvas
  if (backend === 'dom') {
    const style = (element as HTMLElement).style
    style.transform = `scale(${ratio})`
    style.transformOrigin = 'top left'
    host.style.height = `${8 * font.deviceCellHeight}px`
  } else {
    canvas.style.width = `${canvas.width}px`
    canvas.style.height = `${canvas.height}px`
  }
  return { runtime, terminal, state, host, canvas, clock, font, renderer, element, snapshots }
}

function visualRow(row: RenderRow, order: readonly number[], mirror = false): RenderRow {
  const full = order.concat(
    Array.from({ length: row.cells.length - order.length }, (_, i) => i + order.length),
  )
  return {
    ...row,
    cells: full.map((logical, x) => {
      const cell = row.cells[logical]!
      let text = cell.text
      if (mirror && logical === 1) text = ')'
      if (mirror && logical === 3) text = '('
      return { ...cell, x, text }
    }),
  }
}

function atlasOracle(
  canvas: HTMLCanvasElement,
  row: RenderRow,
  font: ReturnType<typeof fittedFont>,
  integerAlpha: boolean,
): void {
  const context = canvas.getContext('2d')!
  context.clearRect(0, 0, canvas.width, canvas.height)
  const rasterizer = new CanvasGlyphRasterizer({ font })
  const composed = new ImageData(canvas.width, canvas.height)
  for (const cell of row.cells) {
    if (!cell.text || cell.continuation) continue
    const span = row.cells[cell.x + 1]?.continuation ? 2 : 1
    const bitmap = rasterizer.rasterize({
      text: cell.text,
      cellSpan: span,
      foreground: { r: 221, g: 221, b: 221 },
      weight: 'normal',
      italic: false,
    })
    if (!bitmap) continue
    if (integerAlpha) {
      composeStamp(composed, bitmap, cell.x * font.deviceCellWidth + bitmap.offsetX, bitmap.offsetY)
      continue
    }
    const stamp = document.createElement('canvas')
    stamp.width = bitmap.width
    stamp.height = bitmap.height
    const image = new ImageData(bitmap.width, bitmap.height)
    if (bitmap.kind === 'color') image.data.set(bitmap.pixels)
    else fillGrayscale(image, bitmap.pixels)
    stamp.getContext('2d')!.putImageData(image, 0, 0)
    context.drawImage(stamp, cell.x * font.deviceCellWidth + bitmap.offsetX, bitmap.offsetY)
  }
  if (integerAlpha) {
    context.putImageData(composed, 0, 0)
    context.clearRect(0, font.deviceCellHeight, canvas.width, canvas.height - font.deviceCellHeight)
  }
}

function composeStamp(target: ImageData, bitmap: GlyphBitmap, x: number, y: number): void {
  for (let pixel = 0; pixel < bitmap.width * bitmap.height; pixel += 1) {
    const column = x + (pixel % bitmap.width)
    const row = y + Math.floor(pixel / bitmap.width)
    if (column < 0 || column >= target.width || row < 0 || row >= target.height) continue
    const color = bitmap.kind === 'color'
    const source = pixel * (color ? 4 : 1)
    const alpha = bitmap.pixels[source + (color ? 3 : 0)]!
    if (!alpha) continue
    const offset = (row * target.width + column) * 4
    const previous = target.data[offset + 3]!
    const denominator = alpha * 255 + previous * (255 - alpha)
    blendChannels(target.data, offset, bitmap, source, alpha, previous, denominator)
    const rounded = denominator + 128
    target.data[offset + 3] = (rounded + (rounded >> 8)) >> 8
  }
}

function blendChannels(
  target: Uint8ClampedArray,
  offset: number,
  bitmap: GlyphBitmap,
  source: number,
  alpha: number,
  previous: number,
  denominator: number,
): void {
  for (let c = 0; c < 3; c += 1) {
    const color = bitmap.kind === 'color' ? bitmap.pixels[source + c]! : 221
    target[offset + c] = Math.floor(
      (color * alpha * 255 +
        target[offset + c]! * previous * (255 - alpha) +
        Math.floor(denominator / 2)) /
        denominator,
    )
  }
}

function fillGrayscale(image: ImageData, alpha: Uint8Array): void {
  for (let i = 0; i < alpha.length; i += 1) {
    image.data.set([221, 221, 221, alpha[i]!], i * 4)
  }
}

function domOracle(
  row: RenderRow,
  font: ReturnType<typeof fittedFont>,
  width: number,
): HTMLElement {
  const frame = document.createElement('div')
  const ratio = font.pixelRatio
  frame.style.cssText = `width:${width / ratio}px;height:${8 * font.cssCellHeight}px;transform:scale(${ratio});transform-origin:top left;overflow:hidden;background:rgb(17,17,17);color:rgb(221,221,221);font-family:${font.settings.family};font-size:${font.settings.size}px;line-height:${font.cssCellHeight}px;white-space:pre;direction:ltr;unicode-bidi:bidi-override`
  for (const cell of row.cells) {
    if (cell.continuation) continue
    const span = document.createElement('span')
    const width = row.cells[cell.x + 1]?.continuation ? 2 : 1
    span.style.cssText = `display:inline-block;flex:none;contain:size layout;direction:ltr;unicode-bidi:bidi-override;height:${font.cssCellHeight}px;vertical-align:top;width:${width * font.cssCellWidth}px;letter-spacing:calc(${font.cssCellWidth}px - 1ch);${width > 1 ? 'text-align:center;' : ''}`
    span.textContent = cell.text || ' '
    frame.append(span)
  }
  document.body.append(frame)
  cleanups.push(() => frame.remove())
  return frame
}

type PaintFixture = (typeof fixtures)[number] & { readonly ratio: number }

async function assertPaint(backend: string, fixture: PaintFixture): Promise<void> {
  const ratio = fixture.ratio
  const f = await create(backend, ratio, fixture.input)
  const logical = f.state.readRows()
  const map = new RowBidiMapper().getMap(logical[0]!.cells)
  expect(map.visualToLogical.slice(0, fixture.map.length)).toEqual(fixture.map)
  const expectedRow = visualRow(logical[0]!, fixture.map, fixture.name === 'punctuation')
  const reference = document.createElement('canvas')
  reference.width = f.canvas.width
  reference.height = f.canvas.height
  reference.style.backgroundColor = 'rgb(17,17,17)'
  document.body.append(reference)
  cleanups.push(() => reference.remove())
  const painter = new CanvasRowPainter(
    reference.getContext('2d')!,
    f.font,
    canonicalRendererTheme(mergeRendererTheme(undefined)),
  )
  painter.resetContext(f.font)
  painter.paint(expectedRow, undefined, reference.width)
  if (backend === 'pixels') atlasOracle(reference, expectedRow, f.font, true)
  const expectedElement = await oracleElement(backend, expectedRow, f.font, reference)
  if (
    (ratio === 1 && fixture.name === 'mixed') ||
    (backend === 'pixels' && fixture.name === 'arabic')
  ) {
    await page.screenshot({
      element: f.element,
      path: `../../.artifacts/c3-${backend}-${fixture.name}-${ratio}-actual.png`,
      scale: 'css',
    })
    await page.screenshot({
      element: expectedElement,
      path: `../../.artifacts/c3-${backend}-${fixture.name}-${ratio}-expected.png`,
      scale: 'css',
    })
  }
  const actual = await pixels(f.element)
  const oracle = await pixels(expectedElement)
  expect(actual.length).toBe(oracle.length)
  const differing = actual.reduce(
    (count, value, i) => count + Number(Math.abs(value - oracle[i]!) > 2),
    0,
  )
  expect(differing, 'Pixel bytes outside antialiasing tolerance').toBe(0)
  expect(f.snapshots.at(-1)!.rows[0]!.text.trimEnd()).toBe(
    logical[0]!.cells.map((cell) => cell.text).join(''),
  )
}

async function oracleElement(
  backend: string,
  row: RenderRow,
  font: ReturnType<typeof fittedFont>,
  reference: HTMLCanvasElement,
): Promise<Element> {
  if (backend === 'dom') return domOracle(row, font, reference.width)
  if (backend !== 'webgpu' && backend !== 'webgl') return reference
  const text = row.cells
    .filter((cell) => !cell.continuation)
    .map((cell) => cell.text || ' ')
    .join('')
  const control = await create(
    backend,
    font.pixelRatio,
    `\x1b[?25l\x1b[?2027h${text}`,
    row.cells.length,
    false,
  )
  return control.element
}

async function assertCursor(backend: string, style: 'block' | 'bar' | 'underline'): Promise<void> {
  const f = await create(backend, 1, cursor)
  f.terminal.setDefaultCursorStyle(style)
  for (const [logical, visual] of [
    [3, 6],
    [4, 5],
    [6, 3],
    [7, 7],
  ]) {
    f.terminal.write(`\x1b[1;${logical! + 1}H`)
    f.renderer.notifyWrite()
    f.clock.flushFrame()
    expect(f.state.readCursor().viewport?.x).toBe(logical)
    expect(f.snapshots.at(-1)!.paintedCursor?.x).toBe(visual)
    const actual = await pixels(f.element)
    const offset = (19 * f.canvas.width + visual! * 10) * 4
    expect(Array.from(actual.slice(offset, offset + 3))).toEqual(
      style === 'block' ? [238, 238, 238] : [221, 221, 221],
    )
  }
}

async function assertResize(backend: string): Promise<void> {
  const f = await create(backend, 1, resize, 10)
  for (const [columns, expected] of [
    [10, [0, 1, 2, 8, 9, 7, 6, 5, 4, 3]],
    [14, [0, 1, 2, 8, 9, 10, 7, 6, 5, 4, 3, 11, 12, 13]],
    [8, [0, 1, 2, 6, 5, 4, 3, 7]],
  ] as const) {
    f.terminal.resize({ columns, rows: 8 })
    f.renderer.resize({ columns, rows: 8 })
    if (f.clock.frames.size) f.clock.flushFrame()
    expect(new RowBidiMapper().getMap(f.state.readRows()[0]!.cells).visualToLogical).toEqual(
      expected,
    )
  }
}

const paintCases = fixtures.flatMap((fixture) => [1, 2].map((ratio) => ({ ...fixture, ratio })))
describe.each(['canvas', 'pixels', 'dom', 'webgl', 'webgpu'])('BiDi %s', (backend) => {
  const test = it.skipIf(backend === 'webgpu' && !navigator.gpu)
  test.each(paintCases)('maps and paints $name at DPR $ratio', (fixture) =>
    assertPaint(backend, fixture),
  )
  test.each(['block', 'bar', 'underline'] as const)('maps %s cursor cells', (style) =>
    assertCursor(backend, style),
  )
  test('recomputes row maps after reflow', () => assertResize(backend))
  test('does no row mapping with the option disabled', async () => {
    const maps = vi.spyOn(RowBidiMapper.prototype, 'getMap')
    const f = await create(backend, 1, mixed, 40, false)
    f.terminal.write('x')
    f.renderer.notifyWrite()
    f.clock.flushFrame()
    expect(maps).not.toHaveBeenCalled()
  })
})
