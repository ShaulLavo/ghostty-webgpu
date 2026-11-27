import type { AtlasKind, GlyphRasterizationInput } from './types.js'

export function glyphConstraintWidth(input: GlyphRasterizationInput): 1 | 2 {
  return input.constraintWidth ?? (input.cellSpan > 1 ? 2 : 1)
}

export function glyphKey(input: GlyphRasterizationInput, kind: AtlasKind): string {
  const header =
    (input.cellSpan << 3) |
    ((glyphConstraintWidth(input) - 1) << 2) |
    (input.weight === 'bold' ? 2 : 0) |
    (input.italic ? 1 : 0)
  if (kind === 'grayscale') return `${header}\0${input.text}`
  const { r, g, b } = input.foreground
  return `${header}:${r},${g},${b}\0${input.text}`
}
