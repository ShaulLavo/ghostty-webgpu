import type { AtlasKind, GlyphBitmap, GlyphRasterizer } from './types.js'

export interface CanvasGlyphRasterizerOptions {
  cellHeight: number
  cellWidth: number
  fontFamily: string
  fontSize: number
}

type ScratchCanvas = HTMLCanvasElement | OffscreenCanvas
type ScratchContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const colorGlyphPattern = /\p{Extended_Pictographic}/u

function validateCellSpan(value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new RangeError('cellSpan must be a positive integer')
}

function centeredBaseline(metrics: TextMetrics, height: number, fontSize: number): number {
  const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontSize * 0.8
  const descent =
    metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontSize * 0.2
  return (height + ascent - descent) / 2
}

function bitmapKey(text: string, cellSpan: number): string {
  return `${cellSpan}\u0000${text}`
}

function createScratchCanvas(): ScratchCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1)
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  return canvas
}

function requireContext(canvas: ScratchCanvas): ScratchContext {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context) return context
  throw new Error('Canvas 2D is unavailable for glyph rasterization')
}

function glyphKind(text: string): AtlasKind {
  return colorGlyphPattern.test(text) ? 'color' : 'grayscale'
}

export class CanvasGlyphRasterizer implements GlyphRasterizer {
  private readonly baseline: number
  private readonly bitmaps = new Map<string, GlyphBitmap>()
  private readonly canvas: ScratchCanvas
  private readonly options: CanvasGlyphRasterizerOptions

  constructor(options: CanvasGlyphRasterizerOptions) {
    this.options = options
    this.canvas = createScratchCanvas()
    this.baseline = centeredBaseline(
      this.configure().measureText('Mg'),
      options.cellHeight,
      options.fontSize,
    )
  }

  rasterize(text: string, requestedCellSpan = 1): GlyphBitmap {
    const cellSpan = validateCellSpan(requestedCellSpan)
    const key = bitmapKey(text, cellSpan)
    const cached = this.bitmaps.get(key)
    if (cached) return cached
    const measuredContext = this.configure()
    const metrics = measuredContext.measureText(text)
    const width = this.options.cellWidth * cellSpan
    const height = this.options.cellHeight
    this.canvas.width = width
    this.canvas.height = height
    const context = this.configure()
    context.clearRect(0, 0, width, height)
    context.fillStyle = '#ffffff'
    context.fillText(text, width / 2, this.baseline)
    const image = context.getImageData(0, 0, width, height)
    const kind = glyphKind(text)
    const pixels = kind === 'grayscale' ? grayscalePixels(image.data) : Uint8Array.from(image.data)
    const bitmap = { advance: metrics.width, height, kind, pixels, width }
    this.bitmaps.set(key, bitmap)
    return bitmap
  }

  private configure(): ScratchContext {
    const context = requireContext(this.canvas)
    context.font = `${this.options.fontSize}px ${this.options.fontFamily}`
    context.textAlign = 'center'
    context.textBaseline = 'alphabetic'
    return context
  }
}

function grayscalePixels(source: Uint8ClampedArray): Uint8Array {
  const pixels = new Uint8Array(source.length)
  for (let offset = 0; offset < source.length; offset += 4) {
    const coverage = source[offset + 3] ?? 0
    pixels[offset] = coverage
    pixels[offset + 1] = coverage
    pixels[offset + 2] = coverage
    pixels[offset + 3] = coverage
  }
  return pixels
}
