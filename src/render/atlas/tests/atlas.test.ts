import { describe, expect, it } from 'vitest'
import { GlyphAtlas } from '../atlas.js'
import type { AtlasKind, GlyphBitmap } from '../types.js'

function bitmap(kind: AtlasKind, marker: number, size = 2): GlyphBitmap {
  return {
    advance: size,
    height: size,
    kind,
    pixels: new Uint8Array(size * size * 4).fill(marker),
    width: size,
  }
}

describe('GlyphAtlas', () => {
  it('caches identical glyphs and separates grayscale from color pages', () => {
    const atlas = new GlyphAtlas({ maxPagesPerKind: 1, padding: 0, pageHeight: 8, pageWidth: 8 })
    const first = atlas.getOrInsert('A', bitmap('grayscale', 1), 0)
    const cached = atlas.getOrInsert('A', bitmap('grayscale', 2), 1)
    const color = atlas.getOrInsert('A', bitmap('color', 3), 2)

    expect(cached.glyph).toEqual(first.glyph)
    expect(color.glyph.pageId).not.toBe(first.glyph.pageId)
    expect(color.glyph.kind).toBe('color')
    expect(atlas.pageCount).toBe(2)
  })

  it('increments a recycled page generation and invalidates every referencing row', () => {
    const atlas = new GlyphAtlas({ maxPagesPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    const first = atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 2)
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 5)
    const recycled = atlas.getOrInsert('B', bitmap('grayscale', 2, 4), 8)

    expect(recycled.glyph.pageId).toBe(first.glyph.pageId)
    expect(recycled.glyph.generation).toBe(first.glyph.generation + 1)
    expect(recycled.invalidatedRows).toEqual([2, 5])
    expect(atlas.evictionCount).toBe(1)
    expect(atlas.rowsWithStaleReferences()).toEqual([])
  })

  it('does not invalidate a row after its old page references are released', () => {
    const atlas = new GlyphAtlas({ maxPagesPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 1)
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 2)
    atlas.beginRow(1)
    const recycled = atlas.getOrInsert('B', bitmap('grayscale', 2, 4), 3)

    expect(recycled.invalidatedRows).toEqual([2])
  })

  it('survives repeated CJK and emoji eviction without stale row generations', () => {
    const atlas = new GlyphAtlas({ maxPagesPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    const glyphs = ['界', '語', '文', '字', '🙂', '🚀', '🧭', '🫠']
    for (let index = 0; index < 128; index += 1) {
      const text = glyphs[index % glyphs.length]!
      const kind = index % 2 === 0 ? 'grayscale' : 'color'
      const row = index % 12
      atlas.beginRow(row)
      atlas.getOrInsert(`${text}-${index}`, bitmap(kind, index, 4), row)
      expect(atlas.rowsWithStaleReferences()).toEqual([])
    }

    expect(atlas.evictionCount).toBeGreaterThan(100)
  })

  it('globally invalidates referenced rows and resets upload generations', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    atlas.getOrInsert('A', bitmap('grayscale', 1), 3)
    atlas.getOrInsert('🙂', bitmap('color', 2), 7)
    atlas.consumeUploads()

    expect(atlas.invalidateAll()).toEqual([3, 7])
    expect(atlas.rowsWithStaleReferences()).toEqual([])
    expect(atlas.consumeUploads()).toHaveLength(2)
  })
})
