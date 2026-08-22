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
  private readonly bitmaps = new Map<string, GlyphBitmap>()
  private readonly canvas: ScratchCanvas
  private readonly options: CanvasGlyphRasterizerOptions

  constructor(options: CanvasGlyphRasterizerOptions) {
    this.options = options
    this.canvas = createScratchCanvas()
  }

  rasterize(text: string): GlyphBitmap {
    const cached = this.bitmaps.get(text)
    if (cached) return cached
    const measuredContext = this.configure()
    const metrics = measuredContext.measureText(text)
    const width = Math.max(this.options.cellWidth, Math.ceil(metrics.width) + 2)
    const height = this.options.cellHeight
    this.canvas.width = width
    this.canvas.height = height
    const context = this.configure()
    const ascent = metrics.actualBoundingBoxAscent || this.options.fontSize * 0.8
    const descent = metrics.actualBoundingBoxDescent || this.options.fontSize * 0.2
    const baseline = (height + ascent - descent) / 2
    context.clearRect(0, 0, width, height)
    context.fillStyle = '#ffffff'
    context.fillText(text, 1, baseline)
    const image = context.getImageData(0, 0, width, height)
    const kind = glyphKind(text)
    const pixels = kind === 'grayscale' ? grayscalePixels(image.data) : Uint8Array.from(image.data)
    const bitmap = { advance: metrics.width, height, kind, pixels, width }
    this.bitmaps.set(text, bitmap)
    return bitmap
  }

  private configure(): ScratchContext {
    const context = requireContext(this.canvas)
    context.font = `${this.options.fontSize}px ${this.options.fontFamily}`
    context.textAlign = 'left'
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
