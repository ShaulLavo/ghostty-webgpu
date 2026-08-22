export type AtlasKind = 'color' | 'grayscale'

export interface GlyphBitmap {
  advance: number
  height: number
  kind: AtlasKind
  pixels: Uint8Array
  width: number
}

export interface AtlasGlyph {
  atlasHeight: number
  atlasWidth: number
  generation: number
  height: number
  key: string
  kind: AtlasKind
  pageId: number
  width: number
  x: number
  y: number
}

export interface AtlasInsertResult {
  glyph: AtlasGlyph
  invalidatedRows: readonly number[]
}

export interface AtlasPageUpload {
  generation: number
  height: number
  id: number
  kind: AtlasKind
  pixels: Uint8Array
  width: number
}

export interface GlyphRasterizer {
  rasterize(text: string): GlyphBitmap
}
