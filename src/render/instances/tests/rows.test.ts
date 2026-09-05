import { describe, expect, it } from 'vitest'
import type { RenderCell, RenderRow } from '../../../core/types.js'
import { GlyphAtlas } from '../../atlas/atlas.js'
import type { GlyphBitmap, GlyphRasterizationInput } from '../../atlas/types.js'
import { canonicalRendererTheme } from '../../config.js'
import {
  CELL_INSTANCE_BYTES,
  CELL_INSTANCE_FLOATS,
  CellFlag,
  CellOffset,
  GLYPH_INSTANCE_BYTES,
  GLYPH_INSTANCE_FLOATS,
  GlyphFlag,
  GlyphOffset,
} from '../layout.js'
import { InstanceRows } from '../rows.js'
import { defaultRendererTheme as rawDefaultRendererTheme } from '../types.js'

const defaultRendererTheme = canonicalRendererTheme(rawDefaultRendererTheme)

const source = {
  rasterize(input: GlyphRasterizationInput): GlyphBitmap | undefined {
    if (input.text === ' ') return undefined
    const width = 6
    const kind = input.text === '🙂' ? 'color' : 'grayscale'
    return {
      height: 8,
      kind,
      offsetX: input.italic ? -1 : 1,
      offsetY: 2,
      pixels: new Uint8Array(width * 8 * (kind === 'grayscale' ? 1 : 4)).fill(255),
      width,
    }
  },
}

function lookup(atlas: GlyphAtlas) {
  return {
    beginRow: (row: number) => atlas.beginRow(row),
    resolve: (key: string, bitmap: GlyphBitmap, row: number) => atlas.getOrInsert(key, bitmap, row),
  }
}

function cell(x: number, overrides: Partial<RenderCell> = {}): RenderCell {
  return { continuation: false, selected: false, text: '', x, ...overrides }
}

function row(y: number, cells: readonly RenderCell[]): RenderRow {
  return { cells, dirty: true, y }
}

describe('InstanceRows', () => {
  it('uses WGSL-aligned layouts and stable dirty-row byte ranges', () => {
    expect(CELL_INSTANCE_BYTES % 16).toBe(0)
    expect(GLYPH_INSTANCE_BYTES % 16).toBe(0)
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 4, rows: 3 })
    const atlas = new GlyphAtlas({ pageHeight: 32, pageWidth: 32 })
    const update = instances.rebuildRow(
      row(2, [cell(0, { text: 'A' })]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )

    expect(update.cell).toEqual({
      byteLength: 4 * CELL_INSTANCE_BYTES,
      byteOffset: 2 * 4 * CELL_INSTANCE_BYTES,
    })
    expect(update.glyph).toEqual({
      byteLength: 4 * GLYPH_INSTANCE_BYTES,
      byteOffset: 2 * 4 * GLYPH_INSTANCE_BYTES,
    })
  })

  it('keeps unset backgrounds transparent and explicit backgrounds opaque', () => {
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 2, rows: 1 })
    const atlas = new GlyphAtlas({ pageHeight: 32, pageWidth: 32 })
    instances.rebuildRow(
      row(0, [cell(0), cell(1, { background: { b: 30, g: 20, r: 10 } })]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )

    expect(instances.cellData[CellOffset.Background + 3]).toBe(0)
    expect(instances.cellData[CellOffset.Rect + 2]).toBe(0)
    expect(instances.cellData[CELL_INSTANCE_FLOATS + CellOffset.Background + 3]).toBe(1)
    expect(instances.cellData[CELL_INSTANCE_FLOATS + CellOffset.Rect + 2]).toBe(8)
  })

  it('encodes canonical cursor text over a block cursor', () => {
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 1, rows: 1 })
    const atlas = new GlyphAtlas({ pageHeight: 32, pageWidth: 32 })
    const theme = canonicalRendererTheme({
      ...rawDefaultRendererTheme,
      cursor: { b: 0, g: 255, r: 0 },
      cursorText: { b: 255, g: 0, r: 0 },
    })
    instances.rebuildRow(row(0, [cell(0, { text: 'A' })]), lookup(atlas), source, theme, {
      style: 'block',
      visible: true,
      x: 0,
      y: 0,
    })

    expect(instances.cellData.slice(CellOffset.Foreground, CellOffset.Foreground + 3)).toEqual(
      new Float32Array([0, 0, 1]),
    )
    expect(instances.cellData.slice(CellOffset.Background, CellOffset.Background + 3)).toEqual(
      new Float32Array([0, 1, 0]),
    )
    expect(instances.glyphData.slice(GlyphOffset.Color, GlyphOffset.Color + 3)).toEqual(
      new Float32Array([0, 0, 1]),
    )
  })

  it('does not allocate glyph atlas data for continuation cells', () => {
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 2, rows: 1 })
    const atlas = new GlyphAtlas({ pageHeight: 32, pageWidth: 32 })
    instances.rebuildRow(
      row(0, [cell(0, { text: '界' }), cell(1, { continuation: true, text: 'duplicate' })]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )

    expect((instances.glyphData[GlyphOffset.Meta] ?? 0) & GlyphFlag.Glyph).toBe(GlyphFlag.Glyph)
    expect(instances.glyphData[GlyphOffset.Rect]).toBe(1)
    expect(instances.glyphData[GlyphOffset.Rect + 1]).toBe(2)
    expect(instances.glyphData[GlyphOffset.Rect + 2]).toBe(6)
    expect(instances.glyphData[GlyphOffset.Rect + 3]).toBe(8)
    expect(
      (instances.glyphData[GLYPH_INSTANCE_FLOATS + GlyphOffset.Meta] ?? 0) & GlyphFlag.Glyph,
    ).toBe(0)
  })

  it('encodes selection, inverse, decorations, and outline cursor flags', () => {
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 1, rows: 1 })
    const atlas = new GlyphAtlas({ pageHeight: 32, pageWidth: 32 })
    instances.rebuildRow(
      row(0, [
        cell(0, {
          selected: true,
          style: {
            blink: false,
            bold: false,
            faint: false,
            invisible: false,
            inverse: true,
            italic: false,
            overline: true,
            strikethrough: true,
            underline: 3,
          },
          text: 'A',
        }),
      ]),
      lookup(atlas),
      source,
      defaultRendererTheme,
      { style: 'outline', visible: true, x: 0, y: 0 },
    )

    const flags = instances.cellData[CellOffset.Meta] ?? 0
    expect(flags & CellFlag.Strikethrough).toBeTruthy()
    expect(flags & CellFlag.Overline).toBeTruthy()
    expect(flags & CellFlag.Cursor).toBeTruthy()
    expect(instances.cellData[CellOffset.Meta + 1]).toBe(3)
    expect(instances.cellData[CellOffset.Meta + 2]).toBe(3)
  })

  it('preserves every Ghostty underline style on fixed cells including continuations', () => {
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 5, rows: 1 })
    const atlas = new GlyphAtlas({ pageHeight: 32, pageWidth: 32 })
    const cells = Array.from({ length: 5 }, (_, index) =>
      cell(index, {
        continuation: index === 1,
        style: {
          blink: false,
          bold: false,
          faint: false,
          invisible: false,
          inverse: false,
          italic: false,
          overline: false,
          strikethrough: false,
          underline: index + 1,
        },
      }),
    )
    instances.rebuildRow(row(0, cells), lookup(atlas), source, defaultRendererTheme)

    for (let index = 0; index < 5; index += 1) {
      const offset = index * CELL_INSTANCE_FLOATS + CellOffset.Meta
      expect(instances.cellData[offset + 1]).toBe(index + 1)
    }
  })

  it('keys glyphs by style while faint reuses coverage and empty or invisible cells skip atlas work', () => {
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 6, rows: 1 })
    const atlas = new GlyphAtlas({ pageHeight: 64, pageWidth: 64 })
    const styled = (
      overrides: Partial<NonNullable<RenderCell['style']>>,
    ): NonNullable<RenderCell['style']> => ({
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
    })
    instances.rebuildRow(
      row(0, [
        cell(0, { text: 'A' }),
        cell(1, { style: styled({ bold: true }), text: 'A' }),
        cell(2, { style: styled({ italic: true }), text: 'A' }),
        cell(3, { style: styled({ faint: true }), text: 'A' }),
        cell(4, { style: styled({ invisible: true }), text: 'A' }),
        cell(5, { text: ' ' }),
      ]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )

    expect(atlas.cacheMissCount).toBe(3)
    expect(atlas.cacheHitCount).toBe(1)
    expect(instances.glyphData[2 * GLYPH_INSTANCE_FLOATS + GlyphOffset.Rect]).toBe(15)
    expect(instances.glyphData[3 * GLYPH_INSTANCE_FLOATS + GlyphOffset.Color + 3]).toBe(0.5)
    expect(instances.glyphData[4 * GLYPH_INSTANCE_FLOATS + GlyphOffset.Meta]).toBe(0)
    expect(instances.glyphData[5 * GLYPH_INSTANCE_FLOATS + GlyphOffset.Meta]).toBe(0)
  })

  it('packs distinct atlas layers for glyphs with identical texture coordinates', () => {
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 2, rows: 1 })
    const atlas = new GlyphAtlas({
      maxLayersPerKind: 2,
      padding: 1,
      pageHeight: 10,
      pageWidth: 8,
    })
    instances.rebuildRow(
      row(0, [cell(0, { text: 'A' }), cell(1, { text: 'B' })]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )

    expect(instances.glyphData[GlyphOffset.Atlas]).toBe(0)
    expect(instances.glyphData[GLYPH_INSTANCE_FLOATS + GlyphOffset.Atlas]).toBe(1)
    expect(instances.glyphData[GlyphOffset.Uv]).toBe(
      instances.glyphData[GLYPH_INSTANCE_FLOATS + GlyphOffset.Uv],
    )
    expect(atlas.pageCount).toBe(2)
  })

  it('returns atlas eviction invalidations while keeping row references current', () => {
    const instances = new InstanceRows({ cellHeight: 4, cellWidth: 4, columns: 1, rows: 2 })
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 8, pageWidth: 8 })
    instances.rebuildRow(
      row(0, [cell(0, { text: 'A' })]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )
    const update = instances.rebuildRow(
      row(1, [cell(0, { text: 'B' })]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )

    expect(update.invalidatedRows).toEqual([0])
    expect(atlas.rowsWithStaleReferences()).toEqual([])
  })
})
