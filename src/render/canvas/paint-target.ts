import type { GlyphRasterizationInput } from '../atlas/types.js'
import type { Canvas2dContext } from './painter.js'

export type PaintTarget = Pick<
  Canvas2dContext,
  | 'beginPath'
  | 'clearRect'
  | 'clip'
  | 'fillRect'
  | 'fillStyle'
  | 'fillText'
  | 'font'
  | 'globalAlpha'
  | 'lineTo'
  | 'lineWidth'
  | 'moveTo'
  | 'rect'
  | 'restore'
  | 'save'
  | 'setLineDash'
  | 'stroke'
  | 'strokeRect'
  | 'strokeStyle'
  | 'textAlign'
  | 'textBaseline'
> & {
  glyph?(input: GlyphRasterizationInput, cellX: number, cellY: number): void
}
