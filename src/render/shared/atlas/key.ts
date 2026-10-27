import type { AtlasKind, GlyphRasterizationInput } from './types.js'

export function glyphConstraintWidth(input: GlyphRasterizationInput): 1 | 2 {
  return input.constraintWidth ?? (input.cellSpan > 1 ? 2 : 1)
}

export function glyphKey(input: GlyphRasterizationInput, kind: AtlasKind): string {
  const key = [input.cellSpan, glyphConstraintWidth(input), input.weight, input.italic, input.text]
  if (kind === 'color') key.push(input.foreground.r, input.foreground.g, input.foreground.b)
  return JSON.stringify(key)
}
