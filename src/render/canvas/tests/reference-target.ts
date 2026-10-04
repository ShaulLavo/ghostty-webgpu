import { createGhosttyError } from '../../../core/error.js'
import type { Canvas2dContext } from '../painter.js'

import type { PixelMetrics, PixelTarget } from '../pixel-target.js'

function scratchCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): HTMLCanvasElement | OffscreenCanvas {
  if ('ownerDocument' in canvas) return canvas.ownerDocument.createElement('canvas')
  return new OffscreenCanvas(1, 1)
}

export class ReferenceTarget implements PixelTarget {
  readonly context: Canvas2dContext
  metrics: PixelMetrics = {
    bufferMoves: 0,
    movedRows: 0,
    rasterReadbackBytes: 0,
    rowCopyBytes: 0,
    uploadedRegions: 0,
    uploadedPixelBytes: 0,
  }
  private readonly scratch: HTMLCanvasElement | OffscreenCanvas
  private readonly dirty = new Set<number>()
  private image?: ImageData
  private rowHeight = 0

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly output: Canvas2dContext,
  ) {
    this.scratch = scratchCanvas(canvas)
    const context = this.scratch.getContext('2d', {
      alpha: true,
      willReadFrequently: false,
    }) as Canvas2dContext | null
    if (!context)
      throw createGhosttyError('canvas.pixels', 'Canvas pixel rasterization is unavailable')
    this.context = context
  }

  resize(width: number, height: number, rowHeight: number): void {
    this.scratch.width = width
    this.scratch.height = rowHeight
    this.rowHeight = rowHeight
    this.image = this.output.createImageData(width, height)
    this.dirty.clear()
  }

  beginRow(y: number): void {
    this.context.setTransform(1, 0, 0, 1, 0, -y * this.rowHeight)
  }

  finishRow(y: number): void {
    const image = this.requireImage()
    // Browser composition retains brush-dependent coverage and native alpha rounding.
    const row = this.context.getImageData(0, 0, image.width, this.rowHeight)
    image.data.set(row.data, y * row.data.length)
    this.metrics.rasterReadbackBytes += row.data.byteLength
    this.metrics.rowCopyBytes += row.data.byteLength
    this.dirty.add(y)
  }

  copyRows(offset: number): void {
    const image = this.requireImage()
    const rowBytes = image.width * this.rowHeight * 4
    const source = Math.max(0, -offset)
    const target = Math.max(0, offset)
    const rows = image.height / this.rowHeight - Math.abs(offset)
    image.data.copyWithin(target * rowBytes, source * rowBytes, (source + rows) * rowBytes)
    for (let row = target; row < target + rows; row++) this.dirty.add(row)
    this.metrics.bufferMoves += 1
    this.metrics.movedRows += rows
  }

  present(): void {
    const rows = [...this.dirty].sort((left, right) => left - right)
    if (rows.length === 0) return
    let first = rows[0]!
    let last = first
    for (const row of rows.slice(1)) {
      if (row === last + 1) {
        last = row
        continue
      }
      this.presentRows(first, last)
      first = row
      last = row
    }
    this.presentRows(first, last)
    this.dirty.clear()
  }

  dispose(): void {
    this.image = undefined
    this.dirty.clear()
    this.scratch.width = 0
    this.scratch.height = 0
  }

  private presentRows(first: number, last: number): void {
    const image = this.requireImage()
    const top = first * this.rowHeight
    const height = (last - first + 1) * this.rowHeight
    // putImageData ignores the context clip, transform and alpha; bound the uploaded region explicitly.
    this.output.putImageData(image, 0, 0, 0, top, image.width, height)
    this.metrics.uploadedRegions += 1
    this.metrics.uploadedPixelBytes += image.width * height * 4
  }

  private requireImage(): ImageData {
    if (this.image) return this.image
    throw createGhosttyError('canvas.pixels', 'Canvas pixel storage is unavailable')
  }
}
