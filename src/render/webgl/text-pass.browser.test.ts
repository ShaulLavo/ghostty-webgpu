import { afterEach, expect, it, vi } from 'vitest'
import type { CellStyle, RenderCell, RenderRow } from '../../core/types.js'
import { GlyphAtlas } from '../atlas/atlas.js'
import type { GlyphBitmap, GlyphRasterizer } from '../atlas/types.js'
import { canonicalRendererTheme } from '../config.js'
import { InstanceRows } from '../instances/rows.js'
import { defaultRendererTheme, type CursorState, type RendererTheme } from '../instances/types.js'
import { WebGlTextPass } from './text-pass.js'

const cellSize = 16
const disposables: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
})

function createContext(width: number, height: number): WebGL2RenderingContext {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  document.body.append(canvas)
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: true,
    stencil: false,
  })
  if (!gl) throw new Error('WebGL2 context is unavailable')
  disposables.push(() => {
    canvas.remove()
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  })
  return gl
}

function style(overrides: Partial<CellStyle>): CellStyle {
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

function cell(x: number, overrides: Partial<RenderCell> = {}): RenderCell {
  return { continuation: false, selected: false, text: '', x, ...overrides }
}

function row(y: number, cells: readonly RenderCell[]): RenderRow {
  return { cells, dirty: true, y }
}

function glyphLookup(atlas: GlyphAtlas) {
  return {
    beginRow: (rowIndex: number) => atlas.beginRow(rowIndex),
    resolve: (key: string, bitmap: GlyphBitmap, rowIndex: number) =>
      atlas.getOrInsert(key, bitmap, rowIndex),
  }
}

const rasterizer: GlyphRasterizer = {
  rasterize(input) {
    const bitmap: GlyphBitmap = {
      height: cellSize,
      kind: 'grayscale',
      offsetX: 0,
      offsetY: 0,
      pixels: new Uint8Array(cellSize * cellSize).fill(255),
      width: cellSize,
    }
    if (input.text !== 'color') return bitmap
    const pixels = new Uint8Array(cellSize * cellSize * 4)
    for (let offset = 0; offset < pixels.length; offset += 4)
      pixels.set([200, 100, 50, 128], offset)
    return { ...bitmap, kind: 'color', pixels }
  },
}

function createGrid(options: {
  atlas?: GlyphAtlas
  columns: number
  cursor?: CursorState
  renderRows: readonly RenderRow[]
  rows: number
  theme?: RendererTheme
}) {
  const width = options.columns * cellSize
  const height = options.rows * cellSize
  const gl = createContext(width, height)
  const atlas = options.atlas ?? new GlyphAtlas({ pageHeight: 128, pageWidth: 128 })
  const instances = new InstanceRows({
    cellHeight: cellSize,
    cellWidth: cellSize,
    columns: options.columns,
    rows: options.rows,
  })
  const theme = canonicalRendererTheme(options.theme ?? defaultRendererTheme)
  const updates = options.renderRows.map((renderRow) =>
    instances.rebuildRow(renderRow, glyphLookup(atlas), rasterizer, theme, options.cursor),
  )
  const pass = new WebGlTextPass({
    atlasLayout: atlas.textureLayout,
    context: gl,
    height,
    instanceCount: options.columns * options.rows,
    width,
  })
  disposables.push(() => pass.destroy())
  pass.syncAtlas(atlas.consumeUploads())
  const uploadOperations = pass.upload(instances, updates)
  const pixels = pass.capturePixels()
  expect(gl.getError()).toBe(gl.NO_ERROR)
  return {
    atlas,
    gl,
    instances,
    pass,
    pixel(x: number, y: number) {
      const offset = (y * width + x) * 4
      return [...pixels.subarray(offset, offset + 4)]
    },
    pixels,
    theme,
    uploadOperations,
    width,
  }
}

function coveredPixels(
  pixels: Uint8Array,
  width: number,
  column: number,
  rowIndex: number,
): number {
  let covered = 0
  for (let y = rowIndex * cellSize; y < (rowIndex + 1) * cellSize; y += 1) {
    covered += coveredRowPixels(pixels, width, column * cellSize, y)
  }
  return covered
}

function coveredRowPixels(pixels: Uint8Array, width: number, left: number, y: number): number {
  let covered = 0
  for (let x = left; x < left + cellSize; x += 1) {
    if (pixels[(y * width + x) * 4 + 3]! > 0) covered += 1
  }
  return covered
}

it('renders transparent defaults, explicit backgrounds, inverse and selected cells', () => {
  const grid = createGrid({
    columns: 4,
    renderRows: [
      row(0, [cell(0), cell(1, { background: { r: 255, g: 0, b: 0 } })]),
      row(1, [
        cell(0, {
          foreground: { r: 0, g: 255, b: 0 },
          style: style({ inverse: true }),
        }),
        cell(1, { selected: true }),
        cell(2, { style: style({ invisible: true }), text: 'X' }),
      ]),
    ],
    rows: 2,
    theme: { ...defaultRendererTheme, selectionBackground: { r: 0, g: 0, b: 255 } },
  })
  expect(grid.pixel(8, 8)).toEqual([0, 0, 0, 0])
  expect(grid.pixel(24, 8)).toEqual([255, 0, 0, 255])
  expect(grid.pixel(8, 24)).toEqual([0, 255, 0, 255])
  expect(grid.pixel(24, 24)).toEqual([0, 0, 255, 255])
  expect(grid.pixel(40, 24)).toEqual([0, 0, 0, 0])
  expect(grid.uploadOperations).toBe(2)
})

it('samples grayscale and color texture arrays with premultiplied faint coverage', () => {
  const atlas = new GlyphAtlas({ maxLayersPerKind: 2, pageHeight: 18, pageWidth: 18 })
  const grid = createGrid({
    atlas,
    columns: 4,
    renderRows: [
      row(0, [
        cell(0, { foreground: { r: 20, g: 100, b: 200 }, text: 'X' }),
        cell(1, {
          foreground: { r: 20, g: 100, b: 200 },
          style: style({ faint: true }),
          text: 'Y',
        }),
        cell(2, { text: 'color' }),
        cell(3, { style: style({ faint: true }), text: 'color' }),
      ]),
    ],
    rows: 1,
  })
  expect(grid.atlas.pageCount).toBe(3)
  expect(grid.pixel(8, 8)).toEqual([20, 100, 200, 255])
  expect(grid.pixel(24, 8)).toEqual([10, 50, 100, 128])
  expect(grid.pixel(40, 8)).toEqual([100, 50, 25, 128])
  expect(grid.pixel(56, 8)).toEqual([50, 25, 13, 64])
  expect(grid.pass.atlasUploadOperations).toBe(3)
  expect(grid.pass.atlasUploadedBytes).toBeGreaterThan(0)
})

it('renders every underline style, other decorations, contrast and an outline cursor', () => {
  const grid = createGrid({
    columns: 8,
    cursor: { style: 'outline', visible: true, x: 7, y: 0 },
    renderRows: [
      row(0, [
        ...[1, 2, 3, 4, 5].map((underline, x) => cell(x, { style: style({ underline }) })),
        cell(5, { style: style({ strikethrough: true }) }),
        cell(6, { style: style({ overline: true }) }),
        cell(7),
      ]),
      row(1, [
        cell(0, {
          background: { r: 128, g: 128, b: 128 },
          foreground: { r: 128, g: 128, b: 128 },
          text: 'X',
        }),
      ]),
    ],
    rows: 2,
    theme: { ...defaultRendererTheme, minimumContrast: 7 },
  })
  const coverage = Array.from({ length: 8 }, (_, column) =>
    coveredPixels(grid.pixels, grid.width, column, 0),
  )
  expect(coverage.every((count) => count > 0)).toBe(true)
  expect(coverage[1]).toBeGreaterThan(coverage[0]!)
  expect(coverage[3]).toBeLessThan(coverage[4]!)
  expect(coverage[4]).toBeLessThan(coverage[0]!)
  expect(grid.pixel(120, 8)[3]).toBe(0)
  expect(grid.pixel(112, 8)[3]).toBe(255)
  expect(grid.pixel(8, 24)).toEqual([0, 0, 0, 255])
})

it('renders explicit cursor text and updates one row without replacing the atlas on resize', () => {
  const grid = createGrid({
    columns: 2,
    cursor: { style: 'block', visible: true, x: 0, y: 0 },
    renderRows: [row(0, [cell(0, { text: 'X' })]), row(1, [cell(0)])],
    rows: 2,
    theme: {
      ...defaultRendererTheme,
      cursor: { r: 0, g: 255, b: 0 },
      cursorText: { r: 0, g: 0, b: 255 },
    },
  })
  expect(grid.pixel(8, 8)).toEqual([0, 0, 255, 255])
  const update = grid.instances.rebuildRow(
    row(1, [cell(0, { background: { r: 255, g: 0, b: 0 } })]),
    glyphLookup(grid.atlas),
    rasterizer,
    grid.theme,
  )
  expect(grid.pass.upload(grid.instances, [update])).toBe(2)
  const updated = grid.pass.capturePixels()
  expect([...updated.subarray(8 * 4, 8 * 4 + 4)]).toEqual([0, 0, 255, 255])
  const rowOffset = (24 * grid.width + 8) * 4
  expect([...updated.subarray(rowOffset, rowOffset + 4)]).toEqual([255, 0, 0, 255])

  const atlasOperations = grid.pass.atlasUploadOperations
  const resized = new InstanceRows({
    cellHeight: cellSize,
    cellWidth: cellSize,
    columns: 3,
    rows: 2,
  })
  const resizeUpdates = [
    resized.rebuildRow(
      row(0, [cell(0, { text: 'X' })]),
      glyphLookup(grid.atlas),
      rasterizer,
      grid.theme,
      { style: 'block', visible: true, x: 0, y: 0 },
    ),
    resized.rebuildRow(
      row(1, [cell(0, { background: { r: 255, g: 0, b: 0 } })]),
      glyphLookup(grid.atlas),
      rasterizer,
      grid.theme,
    ),
  ]
  grid.gl.canvas.width = cellSize * 3
  grid.pass.resize({ height: cellSize * 2, instanceCount: 6, width: cellSize * 3 })
  grid.pass.upload(resized, resizeUpdates)
  grid.gl.clearColor(0, 0, 0, 0)
  grid.gl.clear(grid.gl.COLOR_BUFFER_BIT)
  const resizedPixels = grid.pass.capturePixels()
  expect([...resizedPixels.subarray(8 * 4, 8 * 4 + 4)]).toEqual([0, 0, 255, 255])
  const resizedRowOffset = (24 * cellSize * 3 + 8) * 4
  expect([...resizedPixels.subarray(resizedRowOffset, resizedRowOffset + 4)]).toEqual([
    255, 0, 0, 255,
  ])
  expect(resizedPixels.length).toBe(cellSize * 3 * cellSize * 2 * 4)
  expect(grid.pass.atlasUploadOperations).toBe(atlasOperations)
  expect(grid.gl.getError()).toBe(grid.gl.NO_ERROR)
})

it('releases partial initialization resources after an allocation failure', () => {
  const gl = createContext(16, 16)
  const createProgram = vi.spyOn(gl, 'createProgram')
  const createShader = vi.spyOn(gl, 'createShader')
  const createBuffer = gl.createBuffer.bind(gl)
  vi.spyOn(gl, 'createBuffer')
    .mockImplementationOnce(createBuffer)
    .mockImplementationOnce(() => {
      throw new Error('WebGL resource allocation failed')
    })
  expect(
    () =>
      new WebGlTextPass({
        atlasLayout: { layerCount: 1, pageHeight: 16, pageWidth: 16 },
        context: gl,
        height: 16,
        instanceCount: 1,
        width: 16,
      }),
  ).toThrow('resource allocation failed')
  for (const result of createProgram.mock.results) {
    const program: unknown = result.value
    if (!(program instanceof WebGLProgram)) continue
    expect(gl.isProgram(program)).toBe(false)
  }
  for (const result of createShader.mock.results) {
    const shader: unknown = result.value
    if (!(shader instanceof WebGLShader)) continue
    expect(gl.isShader(shader)).toBe(false)
  }
  expect(gl.getError()).toBe(gl.NO_ERROR)
})
