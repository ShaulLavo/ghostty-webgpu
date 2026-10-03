import { expect, it } from 'vitest'
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
import { createNativeTestState } from './native-state.js'
import { buildZigFrame } from '../atlas/zig-glyphs.js'
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
  return { cellSpan, foreground: { r: 255, g: 255, b: 255 }, italic: false, text, weight: 'normal' }
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

it('keeps native wide continuation ownership and transparent cell semantics', async () => {
  const native = await createNativeTestState(3, 1)
  native.terminal.write('界\x1b[48;2;10;20;30m ')
  native.state.update()
  const builder = native.state.createFrameBuilder(3, 1)
  const atlas = new GlyphAtlas({ pageHeight: 64, pageWidth: 64 })
  const source = new CanvasGlyphRasterizer({ font: fittedFont(8, 16, 14) })
  expect(
    buildZigFrame(builder, atlas, source, {
      cellHeight: 16,
      cellWidth: 8,
      theme: defaultRendererTheme,
      full: true,
      overlayRows: new Set(),
    }),
  ).toBe(0)
  expect(builder.glyphData[GlyphOffset.Meta]! & GlyphFlag.Glyph).toBe(GlyphFlag.Glyph)
  expect(builder.glyphData[GlyphOffset.Rect + 2]).toBeGreaterThan(0)
  expect(builder.glyphData[GlyphOffset.Rect + 2]).toBeLessThanOrEqual(16)
  expect(builder.glyphData[GLYPH_INSTANCE_FLOATS + GlyphOffset.Meta]! & GlyphFlag.Glyph).toBe(0)
  expect(builder.cellData[CellOffset.Background + 3]).toBe(0)
  expect(builder.cellData[2 * CELL_INSTANCE_FLOATS + CellOffset.Background + 3]).toBe(1)
  builder.dispose()
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
