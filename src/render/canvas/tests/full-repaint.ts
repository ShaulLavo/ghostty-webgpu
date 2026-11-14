import type { RenderRow } from '../../../core/types.js'
import type { TerminalFittedFont } from '../../../term/types.js'
import type { CanonicalRendererTheme, CursorState } from '../../shared/instances/types.js'
import { CanvasRowPainter, type Canvas2dContext } from '../painter.js'

function context2d(canvas: HTMLCanvasElement | OffscreenCanvas): Canvas2dContext {
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: false })
  if (!context || !('fillText' in context)) throw new TypeError('Expected a 2D canvas')
  return context
}

export function paintFullReference(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  rows: readonly RenderRow[],
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  cursor: CursorState | undefined,
  pixels: boolean,
): void {
  const context = context2d(canvas)
  if (!pixels) {
    const painter = new CanvasRowPainter(context, font, theme)
    painter.resetContext(font)
    for (const row of rows) painter.paint(row, cursor, canvas.width)
    return
  }
  // WebKit rasterizes translucent ink differently on row-sized and viewport-sized surfaces.
  const scratch =
    'ownerDocument' in canvas
      ? canvas.ownerDocument.createElement('canvas')
      : new OffscreenCanvas(1, 1)
  const raster = context2d(scratch)
  scratch.width = canvas.width
  scratch.height = font.deviceCellHeight
  const painter = new CanvasRowPainter(raster, font, theme)
  painter.resetContext(font)
  try {
    for (const row of rows) {
      raster.setTransform(1, 0, 0, 1, 0, -row.y * font.deviceCellHeight)
      painter.paint(row, cursor, canvas.width)
      const image = raster.getImageData(0, 0, canvas.width, font.deviceCellHeight)
      context.putImageData(image, 0, row.y * font.deviceCellHeight)
    }
  } finally {
    scratch.width = 0
    scratch.height = 0
  }
}
