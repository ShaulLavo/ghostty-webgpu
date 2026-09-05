import { expect, it } from 'vitest'
import type { RenderCell, RenderRow } from '../../core/types.js'
import { calculateTerminalFittedFont } from '../../dom/fit.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { GlyphAtlas } from '../atlas/atlas.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import type { GlyphBitmap, GlyphRasterizationInput } from '../atlas/types.js'
import { canonicalRendererTheme } from '../config.js'
import {
  CELL_INSTANCE_FLOATS,
  CellOffset,
  GLYPH_INSTANCE_FLOATS,
  GlyphFlag,
  GlyphOffset,
} from '../instances/layout.js'
import { InstanceRows } from '../instances/rows.js'
import { defaultRendererTheme as rawDefaultRendererTheme } from '../instances/types.js'

const defaultRendererTheme = canonicalRendererTheme(rawDefaultRendererTheme)

function rasterizer(): CanvasGlyphRasterizer {
  return new CanvasGlyphRasterizer({ font: fittedFont(20, 40, 30) })
}

function fittedFont(cellWidth: number, cellHeight: number, size: number): TerminalFittedFont {
  const charHeight = Math.min(cellHeight, size)
  const charTop = Math.round((cellHeight - charHeight) / 2)
  return Object.freeze({
    charLeft: 0,
    charTop,
    cssCellHeight: cellHeight,
    cssCellWidth: cellWidth,
    deviceBaseline: charTop + Math.ceil(charHeight * 0.8),
    deviceCellHeight: cellHeight,
    deviceCellWidth: cellWidth,
    deviceCharHeight: charHeight,
    deviceCharWidth: cellWidth,
    pixelRatio: 1,
    settings: Object.freeze({
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: cellHeight / charHeight,
      size,
      weight: 400,
    }),
  })
}

function input(text: string, cellSpan = 1): GlyphRasterizationInput {
  return { cellSpan, italic: false, text, weight: 'normal' }
}

function requireBitmap(bitmap: GlyphBitmap | undefined): GlyphBitmap {
  expect(bitmap).toBeDefined()
  return bitmap!
}

function coveredRows(bitmap: GlyphBitmap): readonly number[] {
  const rows: number[] = []
  for (let y = 0; y < bitmap.height; y += 1) {
    if (rowHasCoverage(bitmap, y)) rows.push(y)
  }
  return rows
}

function rowHasCoverage(bitmap: GlyphBitmap, row: number): boolean {
  const bytesPerPixel = bitmap.kind === 'grayscale' ? 1 : 4
  const start = row * bitmap.width * bytesPerPixel
  const end = start + bitmap.width * bytesPerPixel
  const alphaOffset = bitmap.kind === 'grayscale' ? 0 : 3
  for (let offset = start + alphaOffset; offset < end; offset += bytesPerPixel) {
    if ((bitmap.pixels[offset] ?? 0) > 0) return true
  }
  return false
}

function hasCoverage(bitmap: GlyphBitmap): boolean {
  return coveredRows(bitmap).length > 0
}

function cell(x: number, overrides: Partial<RenderCell> = {}): RenderCell {
  return { continuation: false, selected: false, text: '', x, ...overrides }
}

function row(cells: readonly RenderCell[]): RenderRow {
  return { cells, dirty: true, y: 0 }
}

it('keeps alphabetic glyphs and digits on a stable baseline while preserving punctuation and descenders', () => {
  const source = rasterizer()
  const baselineGlyphs = ['A', 'M', 'a', '1']
  const lastRows = baselineGlyphs.map((text) => {
    const bitmap = requireBitmap(source.rasterize(input(text)))
    return bitmap.offsetY + (coveredRows(bitmap).at(-1) ?? -1)
  })

  expect(Math.max(...lastRows) - Math.min(...lastRows)).toBeLessThanOrEqual(1)
  expect(hasCoverage(requireBitmap(source.rasterize(input('.'))))).toBe(true)
  expect(hasCoverage(requireBitmap(source.rasterize(input(','))))).toBe(true)
  expect(hasCoverage(requireBitmap(source.rasterize(input('g'))))).toBe(true)
  expect(hasCoverage(requireBitmap(source.rasterize(input('y'))))).toBe(true)
})

it('covers combining text, CJK, and emoji without changing their requested cell span', () => {
  const source = rasterizer()
  const combining = requireBitmap(source.rasterize(input('e\u0301')))
  const cjk = requireBitmap(source.rasterize(input('界', 2)))
  const emoji = requireBitmap(source.rasterize(input('🧪', 2)))

  expect(hasCoverage(combining)).toBe(true)
  expect(hasCoverage(cjk)).toBe(true)
  expect(hasCoverage(emoji)).toBe(true)
  expect(cjk.offsetX + cjk.width).toBeLessThanOrEqual(40)
  expect(emoji.offsetX + emoji.width).toBeLessThanOrEqual(40)
})

it('keeps wide continuation ownership and transparent cell semantics in row instances', () => {
  const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 2, rows: 1 })
  const atlas = new GlyphAtlas({ pageHeight: 64, pageWidth: 64 })
  const lookup = {
    beginRow: (rowIndex: number) => atlas.beginRow(rowIndex),
    resolve: (key: string, bitmap: GlyphBitmap, rowIndex: number) =>
      atlas.getOrInsert(key, bitmap, rowIndex),
  }
  const source = new CanvasGlyphRasterizer({ font: fittedFont(8, 16, 14) })
  instances.rebuildRow(
    row([
      cell(0, { text: '界' }),
      cell(1, { background: { b: 30, g: 20, r: 10 }, continuation: true }),
    ]),
    lookup,
    source,
    defaultRendererTheme,
  )

  expect((instances.glyphData[GlyphOffset.Meta] ?? 0) & GlyphFlag.Glyph).toBe(GlyphFlag.Glyph)
  expect(instances.glyphData[GlyphOffset.Rect + 2]).toBeGreaterThan(0)
  expect(instances.glyphData[GlyphOffset.Rect + 2]).toBeLessThanOrEqual(16)
  expect(
    (instances.glyphData[GLYPH_INSTANCE_FLOATS + GlyphOffset.Meta] ?? 0) & GlyphFlag.Glyph,
  ).toBe(0)
  expect(instances.cellData[CellOffset.Background + 3]).toBe(0)
  expect(instances.cellData[CELL_INSTANCE_FLOATS + CellOffset.Background + 3]).toBe(1)
})

it('fits fractional DPR inputs to one drift-free character and cell grid', () => {
  for (const pixelRatio of [1, 1.25, 1.5, 2, 2.2]) {
    const font = calculateTerminalFittedFont(
      {
        boldWeight: 800,
        family: 'monospace',
        letterSpacing: 0.5,
        lineHeight: 1.25,
        size: 14,
        weight: 350,
      },
      { advanceWidth: 8.7, fontAscent: 11, fontDescent: 3 },
      pixelRatio,
    )
    expect(Number.isInteger(font.deviceCharHeight)).toBe(true)
    expect(Number.isInteger(font.deviceCharWidth)).toBe(true)
    expect(Number.isInteger(font.deviceCellHeight)).toBe(true)
    expect(Number.isInteger(font.deviceCellWidth)).toBe(true)
    expect(font.cssCellHeight * pixelRatio * 200).toBeCloseTo(font.deviceCellHeight * 200, 10)
    expect(font.cssCellWidth * pixelRatio * 200).toBeCloseTo(font.deviceCellWidth * 200, 10)
  }
})
