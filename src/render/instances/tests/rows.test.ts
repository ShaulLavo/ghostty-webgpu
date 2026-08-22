import { describe, expect, it } from 'vitest'
import type { RenderCell, RenderRow } from '../../../core/types.js'
import { GlyphAtlas } from '../../atlas/atlas.js'
import type { GlyphBitmap } from '../../atlas/types.js'
import {
  BACKGROUND_INSTANCE_BYTES,
  BACKGROUND_INSTANCE_FLOATS,
  BackgroundOffset,
  GLYPH_INSTANCE_BYTES,
  GLYPH_INSTANCE_FLOATS,
  GlyphFlag,
  GlyphOffset,
} from '../layout.js'
import { InstanceRows } from '../rows.js'
import { defaultRendererTheme } from '../types.js'

const source = {
  rasterize(text: string): GlyphBitmap {
    return {
      advance: 8,
      height: 8,
      kind: text === '🙂' ? 'color' : 'grayscale',
      pixels: new Uint8Array(8 * 8 * 4).fill(255),
      width: 8,
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
  return { selected: false, text: '', x, ...overrides }
}

function row(y: number, cells: readonly RenderCell[]): RenderRow {
  return { cells, dirty: true, y }
}

describe('InstanceRows', () => {
  it('uses WGSL-aligned layouts and stable dirty-row byte ranges', () => {
    expect(BACKGROUND_INSTANCE_BYTES % 16).toBe(0)
    expect(GLYPH_INSTANCE_BYTES % 16).toBe(0)
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 4, rows: 3 })
    const atlas = new GlyphAtlas({ pageHeight: 32, pageWidth: 32 })
    const update = instances.rebuildRow(
      row(2, [cell(0, { text: 'A' })]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )

    expect(update.background).toEqual({
      byteLength: 4 * BACKGROUND_INSTANCE_BYTES,
      byteOffset: 2 * 4 * BACKGROUND_INSTANCE_BYTES,
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

    expect(instances.backgroundData[BackgroundOffset.Color + 3]).toBe(0)
    expect(instances.backgroundData[BACKGROUND_INSTANCE_FLOATS + BackgroundOffset.Color + 3]).toBe(
      1,
    )
  })

  it('does not allocate glyph atlas data for continuation cells', () => {
    const instances = new InstanceRows({ cellHeight: 16, cellWidth: 8, columns: 2, rows: 1 })
    const atlas = new GlyphAtlas({ pageHeight: 32, pageWidth: 32 })
    instances.rebuildRow(
      row(0, [cell(0, { text: '界' }), cell(1)]),
      lookup(atlas),
      source,
      defaultRendererTheme,
    )

    expect((instances.glyphData[GlyphOffset.Meta] ?? 0) & GlyphFlag.Glyph).toBe(GlyphFlag.Glyph)
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

    const flags = instances.glyphData[GlyphOffset.Meta] ?? 0
    expect(flags & GlyphFlag.Underline).toBeTruthy()
    expect(flags & GlyphFlag.Undercurl).toBeTruthy()
    expect(flags & GlyphFlag.Strikethrough).toBeTruthy()
    expect(flags & GlyphFlag.Overline).toBeTruthy()
    expect(flags & GlyphFlag.Inverse).toBeTruthy()
    expect(flags & GlyphFlag.Selected).toBeTruthy()
    expect(flags & GlyphFlag.OutlineCursor).toBeTruthy()
  })

  it('returns atlas eviction invalidations while keeping row references current', () => {
    const instances = new InstanceRows({ cellHeight: 4, cellWidth: 4, columns: 1, rows: 2 })
    const atlas = new GlyphAtlas({ maxPagesPerKind: 1, padding: 0, pageHeight: 8, pageWidth: 8 })
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
