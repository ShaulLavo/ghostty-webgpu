import type { TerminalFittedFont } from '../../term/types.js'
import type { PaintTarget } from './paint-target.js'
import type { Canvas2dContext } from './painter.js'

export interface PixelMetrics {
  bufferMoves: number
  movedRows: number
  rasterReadbackBytes: number
  rowCopyBytes: number
  uploadedRegions: number
  uploadedPixelBytes: number
}

export interface PixelTarget {
  readonly context: PaintTarget
  /** Row-scratch targets cannot preserve unchanged cells across alternating row paints. */
  readonly cellDamage?: boolean
  metrics: PixelMetrics
  setFont?(font: TerminalFittedFont): void
  invalidate?(): void
  resize(width: number, height: number, rowHeight: number): void
  beginRow(y: number): void
  finishRow(y: number): void
  /** Moves framebuffer rows after the output canvas has copied the same rows. */
  copyRows(offset: number): void
  present(): void
  dispose(): void
}

export type PixelTargetFactory = (
  canvas: HTMLCanvasElement | OffscreenCanvas,
  output: Canvas2dContext,
) => PixelTarget
