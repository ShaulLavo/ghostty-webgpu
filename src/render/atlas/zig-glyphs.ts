import type { ZigFrameBuilder, ZigFrameOptions } from '../../core/zig-frame.js'
import { GLYPH_INSTANCE_FLOATS, GlyphFlag, GlyphOffset } from '../instances/layout.js'
import type { GlyphAtlas } from './atlas.js'
import type { GlyphRasterizer } from './types.js'
import { glyphKey } from './key.js'

// The native index retains glyphs across rows; a viewport row cannot own its residency.
export const zigGlyphRow = -1

export function buildZigFrame(
  builder: ZigFrameBuilder,
  atlas: GlyphAtlas,
  rasterizer: GlyphRasterizer,
  options: ZigFrameOptions,
): number {
  let status = builder.build(options)
  // Recovery starts from empty pages; color classification can need a second glyph sweep.
  for (let attempt = 0; attempt < 3 && status === 2; attempt += 1) {
    if (!registerZigGlyphs(builder, atlas, rasterizer)) {
      atlas.invalidateAll()
      options.full = true
    }
    status = builder.build(options)
  }
  return status
}

export function registerZigGlyphs(
  builder: ZigFrameBuilder,
  atlas: GlyphAtlas,
  rasterizer: GlyphRasterizer,
): boolean {
  atlas.beginRow(zigGlyphRow)
  if (!touchRetainedGlyphs(builder, atlas)) {
    builder.clearGlyphs()
    return false
  }
  const evictions = atlas.evictionCount
  for (const key of builder.missingGlyphs) {
    const input = builder.glyphInput(key)
    const bitmap = rasterizer.rasterize(input)
    if (!bitmap) {
      builder.registerGlyph(key, undefined)
      continue
    }
    const result = atlas.getOrInsert(glyphKey(input, bitmap.kind), bitmap, zigGlyphRow)
    builder.registerGlyph(key, result.glyph)
  }
  // Recycles can remove historical native keys even when no visible row held the page.
  if (atlas.evictionCount !== evictions) {
    builder.clearGlyphs()
    return false
  }
  return true
}

function touchRetainedGlyphs(builder: ZigFrameBuilder, atlas: GlyphAtlas): boolean {
  // Missing slots are empty; known and clean-row records retain their current page generation.
  const data = builder.glyphData
  const touched = new Map<number, number>()
  for (let offset = 0; offset < data.length; offset += GLYPH_INSTANCE_FLOATS) {
    if ((data[offset + GlyphOffset.Meta]! & GlyphFlag.Glyph) === 0) continue
    const layer = data[offset + GlyphOffset.Atlas]!
    const generation = data[offset + GlyphOffset.Atlas + 1]!
    const color = data[offset + GlyphOffset.Atlas + 2] === 1
    const kind = color ? 'color' : 'grayscale'
    const page = layer * 2 + (color ? 1 : 0)
    if (touched.get(page) === generation) continue
    if (!atlas.touchGlyph({ generation, kind, layer }, zigGlyphRow)) return false
    touched.set(page, generation)
  }
  return true
}
