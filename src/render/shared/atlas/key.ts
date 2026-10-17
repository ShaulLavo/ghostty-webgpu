import type { AtlasKind, GlyphRasterizationInput } from './types.js'

export function glyphKey(input: GlyphRasterizationInput, kind: AtlasKind): string {
  const key = [input.cellSpan, input.weight, input.italic, input.text]
  if (kind === 'color') key.push(input.foreground.r, input.foreground.g, input.foreground.b)
  return JSON.stringify(key)
}
