import type { RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import type { CanonicalRendererTheme, CursorState } from '../instances/types.js'
import type { RendererGridSize, WebGpuTerminalRendererOptions } from '../renderer.js'
import {
  RowTerminalRenderer,
  type RowRendererMetrics,
  type RowRendererSurface,
} from '../row-renderer.js'
import { CanvasRowPainter, type Canvas2dContext } from './painter.js'

export type CanvasRendererMetrics = RowRendererMetrics

function requireContext(canvas: HTMLCanvasElement | OffscreenCanvas): Canvas2dContext {
  // Explicit false avoids Chromium's automatic software fallback after incidental pixel reads.
  const context = canvas.getContext('2d', {
    alpha: true,
    willReadFrequently: false,
  }) as Canvas2dContext | null
  if (context) return context
  throw new CanvasUnavailableError()
}

export class CanvasUnavailableError extends TypeError {
  constructor() {
    super('Canvas 2D is unavailable')
    this.name = 'CanvasUnavailableError'
  }
}

class CanvasSurface implements RowRendererSurface {
  private readonly painter: CanvasRowPainter

  constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    options: WebGpuTerminalRendererOptions,
  ) {
    this.painter = new CanvasRowPainter(
      requireContext(canvas),
      options.font,
      canonicalRendererTheme(mergeRendererTheme(options.theme)),
    )
  }

  dispose(): void {}

  paint(row: RenderRow, cursor: CursorState | undefined): void {
    this.painter.paint(row, cursor, this.canvas.width)
  }

  resize(font: TerminalFittedFont, grid: RendererGridSize): void {
    this.canvas.width = grid.columns * font.deviceCellWidth
    this.canvas.height = grid.rows * font.deviceCellHeight
    this.painter.resetContext(font)
    if (!('style' in this.canvas)) return
    this.canvas.style.width = `${grid.columns * font.cssCellWidth}px`
    this.canvas.style.height = `${grid.rows * font.cssCellHeight}px`
  }

  setTheme(theme: CanonicalRendererTheme): void {
    this.painter.setTheme(theme)
  }
}

export class CanvasTerminalRenderer extends RowTerminalRenderer {
  readonly backend = 'canvas2d' as const

  private constructor(options: WebGpuTerminalRendererOptions) {
    super(options, new CanvasSurface(options.canvas, options))
  }

  static create(options: WebGpuTerminalRendererOptions): Promise<CanvasTerminalRenderer> {
    return Promise.resolve(new CanvasTerminalRenderer(options))
  }
}
