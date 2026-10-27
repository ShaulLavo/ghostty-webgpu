import type { RgbColor } from '../../../core/types.js'

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
  cursorText?: RgbColor
  foreground: RgbColor
  minimumContrast: number
  selectionBackground: RgbColor
  selectionForeground: RgbColor
}

export type CanonicalRendererTheme = Omit<RendererTheme, 'cursorText'> & {
  cursorText: RgbColor
}

export interface InstanceByteRange {
  byteLength: number
  byteOffset: number
}

export interface RowInstanceUpdate {
  cell: InstanceByteRange
  glyph: InstanceByteRange
  row: number
}

export { defaultRendererTheme } from '../../../term/theme.js'
