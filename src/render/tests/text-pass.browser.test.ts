import { expect, it } from 'vitest'
import type { CellStyle, RenderCell, RenderRow, RgbColor } from '../../core/types.js'
import { GlyphAtlas } from '../atlas/atlas.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import { AtlasGpuTextures } from '../atlas/gpu-textures.js'
import type { GlyphBitmap } from '../atlas/types.js'
import { InstanceRows } from '../instances/rows.js'
import { defaultRendererTheme, type CursorState, type RendererTheme } from '../instances/types.js'
import { WebGpuTextPass } from '../text-pass.js'

const cellSize = 16
const columns = 4
const rows = 3
const width = columns * cellSize
const height = rows * cellSize
const bytesPerRow = 256

interface RenderedGrid {
  destroy(): void
  pass: WebGpuTextPass
  pixel(x: number, y: number): readonly number[]
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
  return { selected: false, text: '', x, ...overrides }
}

function renderRow(y: number, cells: readonly RenderCell[]): RenderRow {
  return { cells, dirty: true, y }
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
      cell(1, { style: style({ underline: 3 }) }),
      cell(2, { style: style({ strikethrough: true }) }),
      cell(3, { style: style({ overline: true }) }),
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
    ]),
  ]
}

async function renderGrid(
  device: GPUDevice,
  theme: RendererTheme,
  cursor: CursorState,
): Promise<RenderedGrid> {
  const atlas = new GlyphAtlas({ pageHeight: 256, pageWidth: 256 })
  const rasterizer = new CanvasGlyphRasterizer({
    cellHeight: cellSize,
    cellWidth: cellSize,
    fontFamily: 'monospace',
    fontSize: 14,
  })
  const instances = new InstanceRows({
    cellHeight: cellSize,
    cellWidth: cellSize,
    columns,
    rows,
  })
  const updates = testRows().map((row) =>
    instances.rebuildRow(row, glyphLookup(atlas), rasterizer, theme, cursor),
  )
  const atlasTextures = new AtlasGpuTextures()
  atlasTextures.sync(device, atlas.consumeUploads())
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
    uploadedBytes: columns * rows * (32 + 96),
  })
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

  expect(grid.pixel(8, 29)[3]).toBeGreaterThan(0)
  expect(regionHasAlpha(grid, 16, 27, cellSize)).toBe(true)
  expect(grid.pixel(40, 24)[3]).toBeGreaterThan(0)
  expect(grid.pixel(56, 17)[3]).toBeGreaterThan(0)
  expect(grid.pixel(8, 40)).toEqual([255, 0, 0, 255])
  expect(grid.pixel(24, 40)).toEqual([0, 0, 255, 255])
  expect(grid.pixel(40, 40)).toEqual([0, 0, 0, 0])
  const contrasted = grid.pixel(56, 40)
  expect(contrasted[0]).toBeLessThan(20)
  expect(contrasted[1]).toBeLessThan(20)
  expect(contrasted[2]).toBeLessThan(20)
  expect(contrasted[3]).toBe(255)
  grid.destroy()
  device.destroy()
})
