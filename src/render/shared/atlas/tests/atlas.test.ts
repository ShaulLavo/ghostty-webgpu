import { describe, expect, it } from 'vitest'
import { GlyphAtlas } from '../atlas.js'
import type { AtlasKind, AtlasPageUpload, GlyphBitmap } from '../types.js'

function bitmap(kind: AtlasKind, marker: number, width = 2, height = width): GlyphBitmap {
  return {
    height,
    kind,
    offsetX: 0,
    offsetY: 0,
    pixels: new Uint8Array(width * height * (kind === 'grayscale' ? 1 : 4)).fill(marker),
    width,
  }
}

function transferBytes(upload: AtlasPageUpload): number {
  const bytesPerPixel = upload.kind === 'grayscale' ? 1 : 4
  return upload.extent.width * upload.extent.height * bytesPerPixel
}

describe('GlyphAtlas', () => {
  it('caches identical glyphs while grayscale and color use separate layer sequences', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 8, pageWidth: 8 })
    const first = atlas.getOrInsert('A', bitmap('grayscale', 1), 0)
    const cached = atlas.getOrInsert('A', bitmap('grayscale', 2), 1)
    const color = atlas.getOrInsert('A', bitmap('color', 3), 2)

    expect(cached.glyph).toEqual(first.glyph)
    expect(first.glyph.layer).toBe(0)
    expect(color.glyph.layer).toBe(0)
    expect(color.glyph.kind).toBe('color')
    expect(atlas.pageCount).toBe(2)
    expect(atlas.cacheHitCount).toBe(1)
    expect(atlas.cacheMissCount).toBe(2)
  })

  it('allocates three fixed layers before recycling', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 3, padding: 0, pageHeight: 4, pageWidth: 4 })
    const layers = ['A', 'B', 'C'].map(
      (key, row) => atlas.getOrInsert(key, bitmap('grayscale', row + 1, 4), row).glyph.layer,
    )

    expect(layers).toEqual([0, 1, 2])
    expect(atlas.pageCount).toBe(3)
    expect(atlas.evictionCount).toBe(0)
  })

  it('reports exact odd-width grayscale and color dirty regions without packed copies', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 7, pageWidth: 9 })
    atlas.getOrInsert('gray', bitmap('grayscale', 7, 3, 2), 0)
    atlas.getOrInsert('color', bitmap('color', 9, 5, 2), 1)
    const [grayscale, color] = atlas.consumeUploads()

    expect(grayscale).toMatchObject({
      bytesPerRow: 9,
      dataOffset: 0,
      extent: { height: 2, width: 3 },
      kind: 'grayscale',
      layer: 0,
      origin: { x: 0, y: 0 },
    })
    expect(grayscale?.pixels.byteLength).toBe(63)
    expect(transferBytes(grayscale!)).toBe(6)
    expect(color).toMatchObject({
      bytesPerRow: 36,
      dataOffset: 0,
      extent: { height: 2, width: 5 },
      kind: 'color',
      layer: 0,
      origin: { x: 0, y: 0 },
    })
    expect(color?.pixels.byteLength).toBe(252)
    expect(transferBytes(color!)).toBe(40)
    expect(atlas.consumeUploads()).toEqual([])
  })

  it('coalesces adjacent and distant insertions into one bounded region per dirty layer', () => {
    const adjacent = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    adjacent.getOrInsert('A', bitmap('grayscale', 1), 0)
    adjacent.getOrInsert('B', bitmap('grayscale', 2), 0)
    expect(adjacent.consumeUploads()[0]).toMatchObject({
      extent: { height: 2, width: 4 },
      origin: { x: 0, y: 0 },
    })

    const distant = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    distant.getOrInsert('A', bitmap('grayscale', 1), 0)
    distant.getOrInsert('row-fill', bitmap('grayscale', 2, 6, 2), 0)
    distant.getOrInsert('next-row', bitmap('grayscale', 3), 0)
    expect(distant.consumeUploads()[0]).toMatchObject({
      extent: { height: 4, width: 8 },
      origin: { x: 0, y: 0 },
    })
  })

  it('does not dirty a layer on cache hit', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    atlas.getOrInsert('A', bitmap('grayscale', 1), 0)
    atlas.consumeUploads()
    atlas.getOrInsert('A', bitmap('grayscale', 2), 1)

    expect(atlas.consumeUploads()).toEqual([])
  })

  it('increments a recycled layer generation, invalidates references, and clears the full layer', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    const first = atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 2)
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 5)
    atlas.consumeUploads()
    const recycled = atlas.getOrInsert('B', bitmap('grayscale', 2, 2), 8)
    const upload = atlas.consumeUploads()[0]

    expect(recycled.glyph.layer).toBe(first.glyph.layer)
    expect(recycled.glyph.generation).toBe(first.glyph.generation + 1)
    expect(recycled.invalidatedRows).toEqual([2, 5])
    expect(upload).toMatchObject({
      extent: { height: 4, width: 4 },
      layer: 0,
      origin: { x: 0, y: 0 },
    })
    expect(atlas.evictionCount).toBe(1)
    expect(atlas.rowsWithStaleReferences()).toEqual([])
  })

  it('recycles the deterministic least-recently-used layer at capacity', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 2, padding: 0, pageHeight: 4, pageWidth: 4 })
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 1)
    atlas.getOrInsert('B', bitmap('grayscale', 2, 4), 2)
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 3)
    const recycled = atlas.getOrInsert('C', bitmap('grayscale', 3, 4), 4)

    expect(recycled.glyph.layer).toBe(1)
    expect(recycled.invalidatedRows).toEqual([2])
  })

  it('does not invalidate a row after its old layer references are released', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 1)
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 2)
    atlas.beginRow(1)
    const recycled = atlas.getOrInsert('B', bitmap('grayscale', 2, 4), 3)

    expect(recycled.invalidatedRows).toEqual([2])
  })

  it('survives repeated CJK and emoji eviction without stale row generations', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    const glyphs = ['界', '語', '文', '字', '🙂', '🚀', '🧭', '🫠']
    for (let index = 0; index < 128; index += 1) {
      const text = glyphs[index % glyphs.length]!
      const kind = index % 2 === 0 ? 'grayscale' : 'color'
      const row = index % 12
      atlas.beginRow(row)
      atlas.getOrInsert(text + '-' + index, bitmap(kind, index, 4), row)
      expect(atlas.rowsWithStaleReferences()).toEqual([])
    }

    expect(atlas.evictionCount).toBeGreaterThan(100)
  })

  it('globally invalidates referenced rows and marks every live layer for full upload', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    atlas.getOrInsert('A', bitmap('grayscale', 1), 3)
    atlas.getOrInsert('🙂', bitmap('color', 2), 7)
    atlas.consumeUploads()

    expect(atlas.invalidateAll()).toEqual([3, 7])
    expect(atlas.rowsWithStaleReferences()).toEqual([])
    const uploads = atlas.consumeUploads()
    expect(uploads).toHaveLength(2)
    expect(uploads.map(transferBytes)).toEqual([64, 256])
  })

  it('marks every live layer for restoration without changing glyph generations', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    const glyph = atlas.getOrInsert('A', bitmap('grayscale', 1), 3).glyph
    atlas.consumeUploads()

    atlas.markAllForUpload()
    const upload = atlas.consumeUploads()[0]
    const cached = atlas.getOrInsert('A', bitmap('grayscale', 2), 3).glyph

    expect(upload).toMatchObject({ extent: { height: 8, width: 8 }, layer: 0 })
    expect(cached.generation).toBe(glyph.generation)
  })
})
