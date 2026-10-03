import type { ZigFrameBuilder } from '../../core/zig-frame.js'
import type { CanonicalRendererTheme } from '../instances/types.js'
import type { GlyphAtlas } from './atlas.js'
import type { CanvasGlyphRasterizer } from './canvas-rasterizer.js'
import { glyphKey } from './key.js'

// The native index retains glyphs across rows; a viewport row cannot own its residency.
export const zigGlyphRow = -1

export function registerZigGlyphs(
  builder: ZigFrameBuilder,
  atlas: GlyphAtlas,
  rasterizer: CanvasGlyphRasterizer,
  theme: CanonicalRendererTheme,
): boolean {
  for (const key of builder.missingGlyphs) {
    const input = {
      cellSpan: 1,
      foreground: theme.foreground,
      italic: (key & 256) !== 0,
      text: String.fromCharCode(key & 127),
      weight: (key & 128) !== 0 ? ('bold' as const) : ('normal' as const),
    }
    const bitmap = rasterizer.rasterize(input)
    if (!bitmap) {
      builder.registerGlyph(key, undefined)
      continue
    }
    if (bitmap.kind !== 'grayscale') return false
    const result = atlas.getOrInsert(glyphKey(input, bitmap.kind), bitmap, zigGlyphRow)
    if (result.invalidatedRows.length > 0) {
      builder.clearGlyphs()
      return false
    }
    builder.registerGlyph(key, result.glyph)
  }
  return true
}
