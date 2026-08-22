export const BACKGROUND_INSTANCE_FLOATS = 8
export const BACKGROUND_INSTANCE_BYTES = BACKGROUND_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT

export const GLYPH_INSTANCE_FLOATS = 24
export const GLYPH_INSTANCE_BYTES = GLYPH_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT

export const BackgroundOffset = {
  Color: 4,
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
  Cursor: 1 << 7,
  Glyph: 1 << 9,
  Invisible: 1 << 6,
  Inverse: 1 << 4,
  OutlineCursor: 1 << 8,
  Overline: 1 << 3,
  Selected: 1 << 5,
  Strikethrough: 1 << 2,
  Undercurl: 1 << 1,
  Underline: 1 << 0,
} as const
