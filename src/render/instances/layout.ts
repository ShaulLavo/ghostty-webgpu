export const CELL_INSTANCE_FLOATS = 16
export const CELL_INSTANCE_BYTES = CELL_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT

export const GLYPH_INSTANCE_FLOATS = 24
export const GLYPH_INSTANCE_BYTES = GLYPH_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT

export const CellOffset = {
  Background: 8,
  Foreground: 4,
  Meta: 12,
  Rect: 0,
} as const

export const GlyphOffset = {
  Atlas: 20,
  Background: 12,
  Color: 4,
  Meta: 16,
  Rect: 0,
  Uv: 8,
} as const

export const GlyphFlag = {
  Glyph: 1 << 0,
} as const

export const CellFlag = {
  Cursor: 1 << 0,
  Overline: 1 << 1,
  Strikethrough: 1 << 2,
} as const
