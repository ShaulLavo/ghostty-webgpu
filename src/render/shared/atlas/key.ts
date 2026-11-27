import type { AtlasKind, GlyphRasterizationInput } from './types.js'

export function glyphConstraintWidth(input: GlyphRasterizationInput): 1 | 2 {
  return input.constraintWidth ?? (input.cellSpan > 1 ? 2 : 1)
}

export function glyphKey(input: GlyphRasterizationInput, kind: AtlasKind): string {
  const flags =
    ((glyphConstraintWidth(input) - 1) << 2) |
    (input.weight === 'bold' ? 2 : 0) |
    (input.italic ? 1 : 0)
  if (kind === 'grayscale') return `${input.cellSpan}:${flags}\0${input.text}`
  const { r, g, b } = input.foreground
  return `${input.cellSpan}:${flags}:${r},${g},${b}\0${input.text}`
}
