import { expect, it } from 'vitest'
import type { CellStyle, RenderCell, RenderRow, RgbColor } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { GlyphAtlas } from '../atlas/atlas.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import { AtlasGpuTextures } from '../atlas/gpu-textures.js'
import type { GlyphBitmap, GlyphRasterizer } from '../atlas/types.js'
import { canonicalRendererTheme } from '../config.js'
import { InstanceRows } from '../instances/rows.js'
import { defaultRendererTheme, type CursorState, type RendererTheme } from '../instances/types.js'
import { WebGpuTextPass } from '../text-pass.js'

const cellSize = 16
const columns = 7
const rows = 3
const width = columns * cellSize
const height = rows * cellSize
const bytesPerRow = 512

interface RenderedGrid {
  destroy(): void
  pass: WebGpuTextPass
  pixel(x: number, y: number): readonly number[]
}

interface GridFixture {
  atlas?: GlyphAtlas
  rasterizer?: GlyphRasterizer
  renderRows?: readonly RenderRow[]
}

function rgb(r: number, g: number, b: number): RgbColor {
  return { b, g, r }
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

function renderRow(y: number, cells: readonly RenderCell[]): RenderRow {
  return { cells, dirty: true, y }
}

function fittedFont(): TerminalFittedFont {
  return Object.freeze({
    charLeft: 0,
    charTop: 1,
    cssCellHeight: cellSize,
    cssCellWidth: cellSize,
    deviceBaseline: 12,
    deviceCellHeight: cellSize,
    deviceCellWidth: cellSize,
    deviceCharHeight: 14,
    deviceCharWidth: cellSize,
    pixelRatio: 1,
    settings: Object.freeze({
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: cellSize / 14,
      size: 14,
      weight: 400,
    }),
  })
}

async function createDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU requestAdapter returned null')
  return adapter.requestDevice()
}

function glyphLookup(atlas: GlyphAtlas) {
  return {
    beginRow: (row: number) => atlas.beginRow(row),
    resolve: (key: string, bitmap: GlyphBitmap, row: number) => atlas.getOrInsert(key, bitmap, row),
  }
}

function testRows(): readonly RenderRow[] {
  return [
    renderRow(0, [
      cell(0),
      cell(1, { background: rgb(255, 0, 0) }),
      cell(2, { foreground: rgb(255, 255, 255), text: '█' }),
      cell(3),
    ]),
    renderRow(1, [
      cell(0, { style: style({ underline: 1 }) }),
      cell(1, { continuation: true, style: style({ underline: 2 }) }),
      cell(2, { style: style({ underline: 3 }) }),
      cell(3, { style: style({ underline: 4 }) }),
      cell(4, { style: style({ underline: 5 }) }),
      cell(5, { style: style({ strikethrough: true }) }),
      cell(6, { style: style({ overline: true }) }),
    ]),
    renderRow(2, [
      cell(0, {
        background: rgb(0, 255, 0),
        foreground: rgb(255, 0, 0),
        style: style({ inverse: true }),
      }),
      cell(1, { selected: true }),
      cell(2, { style: style({ invisible: true }), text: '█' }),
      cell(3, { background: rgb(128, 128, 128), foreground: rgb(128, 128, 128), text: '█' }),
      cell(4, { style: style({ bold: true }), text: '█' }),
      cell(5, { style: style({ italic: true }), text: '█' }),
      cell(6, { style: style({ faint: true }), text: '█' }),
    ]),
  ]
}

async function renderGrid(
  device: GPUDevice,
  theme: RendererTheme,
  cursor: CursorState,
  fixture: GridFixture = {},
): Promise<RenderedGrid> {
  const atlas = fixture.atlas ?? new GlyphAtlas({ pageHeight: 256, pageWidth: 256 })
  const rasterizer = fixture.rasterizer ?? new CanvasGlyphRasterizer({ font: fittedFont() })
  const instances = new InstanceRows({
    cellHeight: cellSize,
    cellWidth: cellSize,
    columns,
    rows,
  })
  const updates = (fixture.renderRows ?? testRows()).map((row) =>
    instances.rebuildRow(
      row,
      glyphLookup(atlas),
      rasterizer,
      canonicalRendererTheme(theme),
      cursor,
    ),
  )
  const atlasTextures = new AtlasGpuTextures(device, atlas.textureLayout)
  atlasTextures.sync(atlas.consumeUploads())
  const pass = new WebGpuTextPass({
    device,
    format: 'rgba8unorm',
    height,
    instanceCount: columns * rows,
    width,
  })
  pass.syncAtlas(atlasTextures)
  pass.upload(instances, updates)
  const texture = device.createTexture({
    format: 'rgba8unorm',
    size: [width, height],
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const output = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  pass.submit(texture.createView(), {
    buffer: output,
    bytesPerRow,
    size: [width, height],
    texture,
  })
  await output.mapAsync(GPUMapMode.READ)
  const pixels = Uint8Array.from(new Uint8Array(output.getMappedRange()))
  output.unmap()
  return {
    destroy() {
      output.destroy()
      texture.destroy()
      pass.destroy()
      atlasTextures.destroy()
    },
    pass,
    pixel(x: number, y: number) {
      const offset = y * bytesPerRow + x * 4
      return [...pixels.subarray(offset, offset + 4)]
    },
  }
}

function regionHasAlpha(grid: RenderedGrid, left: number, top: number, size: number): boolean {
  for (let y = top; y < top + size; y += 1) {
    if (rowHasAlpha(grid, left, y, size)) return true
  }
  return false
}

function rowHasAlpha(grid: RenderedGrid, left: number, y: number, size: number): boolean {
  for (let x = left; x < left + size; x += 1) {
    if ((grid.pixel(x, y)[3] ?? 0) > 0) return true
  }
  return false
}

function regionAlphaCount(grid: RenderedGrid, left: number, top: number, size: number): number {
  let count = 0
  for (let y = top; y < top + size; y += 1) {
    for (let x = left; x < left + size; x += 1) {
      if ((grid.pixel(x, y)[3] ?? 0) > 0) count += 1
    }
  }
  return count
}

function regionCoveredRowCount(
  grid: RenderedGrid,
  left: number,
  top: number,
  size: number,
): number {
  let count = 0
  for (let y = top; y < top + size; y += 1) {
    if (rowHasAlpha(grid, left, y, size)) count += 1
  }
  return count
}

function maximumRegionAlpha(grid: RenderedGrid, left: number, top: number, size: number): number {
  let maximum = 0
  for (let y = top; y < top + size; y += 1) {
    for (let x = left; x < left + size; x += 1) {
      maximum = Math.max(maximum, grid.pixel(x, y)[3] ?? 0)
    }
  }
  return maximum
}

it('renders transparent defaults, opaque explicit colors, glyphs, and an outline cursor', async () => {
  const device = await createDevice()
  const theme = {
    ...defaultRendererTheme,
    minimumContrast: 7,
    selectionBackground: rgb(0, 0, 255),
  }
  device.pushErrorScope('validation')
  const grid = await renderGrid(device, theme, { style: 'outline', visible: true, x: 3, y: 0 })
  const validationError = await device.popErrorScope()

  if (validationError) throw new Error(validationError.message)
  expect(grid.pixel(8, 8)).toEqual([0, 0, 0, 0])
  expect(grid.pixel(24, 8)).toEqual([255, 0, 0, 255])
  expect(regionHasAlpha(grid, 32, 0, cellSize)).toBe(true)
  expect(grid.pixel(56, 8)[3]).toBe(0)
  expect(grid.pixel(48, 8)[3]).toBeGreaterThan(0)
  expect(grid.pass.metrics).toEqual({
    draws: 2,
    submittedFrames: 1,
    uploadedBytes: columns * rows * (64 + 96),
    uploadOperations: 2,
  })
  grid.destroy()
  device.destroy()
})

it('renders explicit cursor text over a WebGPU block cursor', async () => {
  const device = await createDevice()
  const rasterizer: GlyphRasterizer = {
    rasterize() {
      return {
        height: cellSize,
        kind: 'grayscale',
        offsetX: 0,
        offsetY: 0,
        pixels: new Uint8Array(cellSize * cellSize).fill(255),
        width: cellSize,
      }
    },
  }
  const theme: RendererTheme = {
    ...defaultRendererTheme,
    cursor: rgb(0, 255, 0),
    cursorText: rgb(0, 0, 255),
  }
  const grid = await renderGrid(
    device,
    theme,
    { style: 'block', visible: true, x: 0, y: 0 },
    { rasterizer, renderRows: [renderRow(0, [cell(0, { text: 'X' })])] },
  )

  expect(grid.pixel(8, 8)).toEqual([0, 0, 255, 255])
  grid.destroy()
  device.destroy()
})

it('renders decorations, inverse, selection, invisibility, and minimum contrast in shader', async () => {
  const device = await createDevice()
  const theme = {
    ...defaultRendererTheme,
    minimumContrast: 7,
    selectionBackground: rgb(0, 0, 255),
  }
  const grid = await renderGrid(device, theme, { style: 'outline', visible: false, x: 0, y: 0 })

  for (let column = 0; column < 5; column += 1) {
    expect(regionHasAlpha(grid, column * cellSize, cellSize, cellSize)).toBe(true)
  }
  const singleRows = regionCoveredRowCount(grid, 0, cellSize, cellSize)
  const doubleRows = regionCoveredRowCount(grid, cellSize, cellSize, cellSize)
  const curlyRows = regionCoveredRowCount(grid, cellSize * 2, cellSize, cellSize)
  const singlePixels = regionAlphaCount(grid, 0, cellSize, cellSize)
  const curlyPixels = regionAlphaCount(grid, cellSize * 2, cellSize, cellSize)
  const dottedPixels = regionAlphaCount(grid, cellSize * 3, cellSize, cellSize)
  const dashedPixels = regionAlphaCount(grid, cellSize * 4, cellSize, cellSize)
  expect(doubleRows).toBeGreaterThan(singleRows)
  expect(curlyRows).toBeGreaterThanOrEqual(singleRows)
  expect(curlyPixels).not.toBe(singlePixels)
  expect(dottedPixels).toBeLessThan(dashedPixels)
  expect(dashedPixels).toBeLessThan(singlePixels)
  expect(grid.pixel(88, 24)[3]).toBeGreaterThan(0)
  expect(grid.pixel(104, 17)[3]).toBeGreaterThan(0)
  expect(grid.pixel(8, 40)).toEqual([255, 0, 0, 255])
  expect(grid.pixel(24, 40)).toEqual([0, 0, 255, 255])
  expect(grid.pixel(40, 40)).toEqual([0, 0, 0, 0])
  const contrasted = grid.pixel(56, 40)
  expect(contrasted[0]).toBeLessThan(20)
  expect(contrasted[1]).toBeLessThan(20)
  expect(contrasted[2]).toBeLessThan(20)
  expect(contrasted[3]).toBe(255)
  expect(regionHasAlpha(grid, 64, 32, cellSize)).toBe(true)
  expect(regionHasAlpha(grid, 80, 32, cellSize)).toBe(true)
  expect(regionHasAlpha(grid, 96, 32, cellSize)).toBe(true)
  expect(maximumRegionAlpha(grid, 96, 32, cellSize)).toBeLessThan(
    maximumRegionAlpha(grid, 32, 0, cellSize),
  )
  grid.destroy()
  device.destroy()
})

it('renders identical atlas coordinates from two layers in one two-draw frame', async () => {
  const device = await createDevice()
  const atlas = new GlyphAtlas({
    maxLayersPerKind: 2,
    padding: 1,
    pageHeight: 10,
    pageWidth: 8,
  })
  const rasterizer: GlyphRasterizer = {
    rasterize(input) {
      const coverage = input.text === 'A' ? 255 : 128
      return {
        height: 8,
        kind: 'grayscale',
        offsetX: 1,
        offsetY: 4,
        pixels: new Uint8Array(6 * 8).fill(coverage),
        width: 6,
      }
    },
  }
  const grid = await renderGrid(
    device,
    defaultRendererTheme,
    { style: 'outline', visible: false, x: 0, y: 0 },
    {
      atlas,
      rasterizer,
      renderRows: [renderRow(0, [cell(0, { text: 'A' }), cell(1, { text: 'B' })])],
    },
  )

  expect(atlas.pageCount).toBe(2)
  expect(regionHasAlpha(grid, 0, 0, cellSize)).toBe(true)
  expect(regionHasAlpha(grid, cellSize, 0, cellSize)).toBe(true)
  expect(maximumRegionAlpha(grid, cellSize, 0, cellSize)).toBeLessThan(
    maximumRegionAlpha(grid, 0, 0, cellSize),
  )
  expect(grid.pass.metrics.draws).toBe(2)
  expect(grid.pass.glyphBindGroupCreationCount).toBe(1)
  grid.destroy()
  device.destroy()
})
