import type { ZigFrameBuilder, ZigFrameOptions } from '../../../core/zig-frame.js'
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
  invalidateEvictedPages(builder, atlas)
  let status = builder.build(options)
  if (status !== 2 && !builder.hasDeferredGlyphs) return status
  atlas.beginFrame()
  try {
    touchRetainedGlyphs(builder, atlas)
    if (builder.hasDeferredGlyphs && atlas.hasReclaimableSpace && builder.retryDeferredGlyphs())
      status = builder.build(options)
    for (let attempt = 0; attempt < 3 && status === 2; attempt += 1) {
      registerMissingGlyphs(builder, atlas, rasterizer)
      status = builder.build(options)
    }
    return status
  } finally {
    atlas.endFrame()
  }
}

function invalidateEvictedPages(builder: ZigFrameBuilder, atlas: GlyphAtlas): void {
  for (const page of atlas.consumeEvictedPages()) builder.invalidateGlyphPage(page)
}

function registerMissingGlyphs(
  builder: ZigFrameBuilder,
  atlas: GlyphAtlas,
  rasterizer: GlyphRasterizer,
): void {
  for (const key of builder.missingGlyphs) {
    const input = builder.glyphInput(key)
    const bitmap = rasterizer.rasterize(input)
    if (!bitmap) {
      builder.registerGlyph(key, undefined)
      continue
    }
    const result = atlas.tryGetOrInsert(glyphKey(input, bitmap.kind), bitmap, zigGlyphRow)
    if (result) builder.registerGlyph(key, result.glyph)
    if (!result) builder.deferGlyph(key)
  }
  invalidateEvictedPages(builder, atlas)
}

function touchRetainedGlyphs(builder: ZigFrameBuilder, atlas: GlyphAtlas): void {
  atlas.beginRow(zigGlyphRow)
  const data = builder.glyphData
  const touched = new Set<number>()
  for (let offset = 0; offset < data.length; offset += GLYPH_INSTANCE_FLOATS) {
    if ((data[offset + GlyphOffset.Meta]! & GlyphFlag.Glyph) === 0) continue
    const layer = data[offset + GlyphOffset.Atlas]!
    const generation = data[offset + GlyphOffset.Atlas + 1]!
    const color = data[offset + GlyphOffset.Atlas + 2] === 1
    const kind = color ? 'color' : 'grayscale'
    const page = layer * 2 + (color ? 1 : 0)
    const x = Math.round(data[offset + GlyphOffset.Uv]! * atlas.pageWidth)
    const y = Math.round(data[offset + GlyphOffset.Uv + 1]! * atlas.pageHeight)
    const slot = (page * atlas.pageHeight + y) * atlas.pageWidth + x
    if (touched.has(slot)) continue
    atlas.touchGlyph({ generation, kind, layer, x, y }, zigGlyphRow)
    touched.add(slot)
  }
}
