import type { AtlasInsertResult, GlyphBitmap, GlyphRasterizationInput } from '../atlas/types.js'
import type { RgbColor } from '../../core/types.js'

export type CursorStyle = 'bar' | 'block' | 'outline' | 'underline'

export interface CursorState {
  style: CursorStyle
  visible: boolean
  x: number
  y: number
}

export interface RendererTheme {
  background: RgbColor
  cursor: RgbColor
  foreground: RgbColor
  minimumContrast: number
  selectionBackground: RgbColor
  selectionForeground: RgbColor
}

export interface GlyphLookup {
  beginRow(row: number): void
  resolve(key: string, bitmap: GlyphBitmap, row: number): AtlasInsertResult
}

export interface GlyphSource {
  rasterize(input: GlyphRasterizationInput): GlyphBitmap | undefined
}

export interface InstanceByteRange {
  byteLength: number
  byteOffset: number
}

export interface RowInstanceUpdate {
  cell: InstanceByteRange
  glyph: InstanceByteRange
  invalidatedRows: readonly number[]
  row: number
}

export interface InstanceRowsOptions {
  cellHeight: number
  cellWidth: number
  columns: number
  rows: number
}

export const defaultRendererTheme: RendererTheme = {
  background: { b: 17, g: 17, r: 17 },
  cursor: { b: 238, g: 238, r: 238 },
  foreground: { b: 221, g: 221, r: 221 },
  minimumContrast: 1,
  selectionBackground: { b: 85, g: 68, r: 51 },
  selectionForeground: { b: 255, g: 255, r: 255 },
}
