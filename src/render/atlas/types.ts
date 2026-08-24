export type AtlasKind = 'color' | 'grayscale'

export interface GlyphBitmap {
  height: number
  kind: AtlasKind
  offsetX: number
  offsetY: number
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
  layer: number
  offsetX: number
  offsetY: number
  width: number
  x: number
  y: number
}

export interface AtlasInsertResult {
  glyph: AtlasGlyph
  invalidatedRows: readonly number[]
}

export interface AtlasPageUpload {
  bytesPerRow: number
  dataOffset: number
  extent: { height: number; width: number }
  kind: AtlasKind
  layer: number
  origin: { x: number; y: number }
  pixels: Uint8Array
}

export interface AtlasTextureLayout {
  layerCount: number
  pageHeight: number
  pageWidth: number
}

export interface GlyphRasterizer {
  rasterize(input: GlyphRasterizationInput): GlyphBitmap | undefined
}

export interface GlyphRasterizationInput {
  cellSpan: number
  italic: boolean
  text: string
  weight: 'bold' | 'normal'
}
