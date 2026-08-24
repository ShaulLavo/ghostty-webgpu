import type { AtlasKind, GlyphBitmap, GlyphRasterizationInput, GlyphRasterizer } from './types.js'
import type { TerminalFittedFont } from '../../term/types.js'

export interface CanvasGlyphRasterizerOptions {
  font: TerminalFittedFont
}

interface PixelBounds {
  bottom: number
  left: number
  right: number
  top: number
}

type ScratchCanvas = HTMLCanvasElement | OffscreenCanvas
type ScratchContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const colorChannelTolerance = 2
const maxScratchAttempts = 3

function validateInput(input: GlyphRasterizationInput): GlyphRasterizationInput {
  if (!Number.isSafeInteger(input.cellSpan) || input.cellSpan <= 0) {
    throw new RangeError('cellSpan must be a positive integer')
  }
  if (input.weight !== 'normal' && input.weight !== 'bold') {
    throw new TypeError('weight must be normal or bold')
  }
  if (typeof input.italic !== 'boolean') throw new TypeError('italic must be a boolean')
  if (typeof input.text !== 'string') throw new TypeError('text must be a string')
  return input
}

function bitmapKey(input: GlyphRasterizationInput): string {
  return JSON.stringify([input.cellSpan, input.weight, input.italic, input.text])
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

function fontString(
  font: TerminalFittedFont,
  input: Pick<GlyphRasterizationInput, 'italic' | 'weight'>,
): string {
  const italic = input.italic ? 'italic ' : ''
  const weight = input.weight === 'bold' ? font.settings.boldWeight : font.settings.weight
  const size = font.settings.size * font.pixelRatio
  return `${italic}${weight} ${size}px ${font.settings.family}`
}

function alphaBounds(image: ImageData): PixelBounds | undefined {
  let left = image.width
  let right = -1
  let top = image.height
  let bottom = -1
  for (let y = 0; y < image.height; y += 1) {
    const row = alphaRowBounds(image, y)
    if (!row) continue
    left = Math.min(left, row.left)
    right = Math.max(right, row.right)
    top = Math.min(top, y)
    bottom = y
  }
  if (right < left || bottom < top) return undefined
  return { bottom, left, right, top }
}

function alphaRowBounds(
  image: ImageData,
  row: number,
): { left: number; right: number } | undefined {
  let left = image.width
  let right = -1
  for (let x = 0; x < image.width; x += 1) {
    const alpha = image.data[(row * image.width + x) * 4 + 3] ?? 0
    if (alpha === 0) continue
    left = Math.min(left, x)
    right = x
  }
  if (right < left) return undefined
  return { left, right }
}

function touchesScratchEdge(bounds: PixelBounds, width: number, height: number): boolean {
  return (
    bounds.left === 0 ||
    bounds.top === 0 ||
    bounds.right === width - 1 ||
    bounds.bottom === height - 1
  )
}

function glyphKind(image: ImageData, bounds: PixelBounds): AtlasKind {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    if (rowContainsColor(image, bounds, y)) return 'color'
  }
  return 'grayscale'
}

function rowContainsColor(image: ImageData, bounds: PixelBounds, row: number): boolean {
  for (let x = bounds.left; x <= bounds.right; x += 1) {
    const offset = (row * image.width + x) * 4
    const alpha = image.data[offset + 3] ?? 0
    if (alpha === 0) continue
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue)
    if (spread > colorChannelTolerance) return true
  }
  return false
}

function copyPixels(image: ImageData, bounds: PixelBounds, kind: AtlasKind): Uint8Array {
  const width = bounds.right - bounds.left + 1
  const height = bounds.bottom - bounds.top + 1
  const bytesPerPixel = kind === 'grayscale' ? 1 : 4
  const pixels = new Uint8Array(width * height * bytesPerPixel)
  for (let row = 0; row < height; row += 1) {
    copyPixelRow(image, bounds, kind, row, pixels, width)
  }
  return pixels
}

function copyPixelRow(
  image: ImageData,
  bounds: PixelBounds,
  kind: AtlasKind,
  row: number,
  target: Uint8Array,
  width: number,
): void {
  for (let column = 0; column < width; column += 1) {
    const source = ((bounds.top + row) * image.width + bounds.left + column) * 4
    if (kind === 'grayscale') {
      target[row * width + column] = image.data[source + 3] ?? 0
      continue
    }
    const destination = (row * width + column) * 4
    target[destination] = image.data[source] ?? 0
    target[destination + 1] = image.data[source + 1] ?? 0
    target[destination + 2] = image.data[source + 2] ?? 0
    target[destination + 3] = image.data[source + 3] ?? 0
  }
}

export class CanvasGlyphRasterizer implements GlyphRasterizer {
  private readonly bitmaps = new Map<string, GlyphBitmap | undefined>()
  private readonly canvas: ScratchCanvas
  private readonly font: TerminalFittedFont
  private readonly initialPadding: number

  constructor(options: CanvasGlyphRasterizerOptions) {
    this.font = options.font
    this.canvas = createScratchCanvas()
    this.initialPadding = Math.ceil(
      Math.max(this.font.deviceCellHeight, this.font.settings.size * this.font.pixelRatio),
    )
  }

  rasterize(rawInput: GlyphRasterizationInput): GlyphBitmap | undefined {
    const input = validateInput(rawInput)
    const key = bitmapKey(input)
    if (this.bitmaps.has(key)) return this.bitmaps.get(key)
    const bitmap = input.text.length === 0 ? undefined : this.rasterizeUncached(input)
    this.bitmaps.set(key, bitmap)
    return bitmap
  }

  private configure(input: Pick<GlyphRasterizationInput, 'italic' | 'weight'>): ScratchContext {
    const context = requireContext(this.canvas)
    context.font = fontString(this.font, input)
    context.textAlign = 'center'
    context.textBaseline = 'alphabetic'
    return context
  }

  private draw(input: GlyphRasterizationInput, padding: number): ImageData {
    const cellWidth = this.font.deviceCellWidth * input.cellSpan
    const deviceSpacing = this.font.deviceCellWidth - this.font.deviceCharWidth
    const characterWidth = cellWidth - deviceSpacing
    this.canvas.width = Math.ceil(cellWidth + padding * 2)
    this.canvas.height = Math.ceil(this.font.deviceCellHeight + padding * 2)
    const context = this.configure(input)
    context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    context.fillStyle = '#ffffff'
    const drawX = padding + this.font.charLeft + characterWidth / 2
    context.fillText(input.text, drawX, padding + this.font.deviceBaseline)
    return context.getImageData(0, 0, this.canvas.width, this.canvas.height)
  }

  private rasterizeUncached(input: GlyphRasterizationInput): GlyphBitmap | undefined {
    let padding = this.initialPadding
    for (let attempt = 0; attempt < maxScratchAttempts; attempt += 1) {
      const image = this.draw(input, padding)
      const bounds = alphaBounds(image)
      if (!bounds) return undefined
      if (!touchesScratchEdge(bounds, image.width, image.height)) {
        return this.bitmapFromImage(image, bounds, padding)
      }
      padding *= 2
    }
    throw new RangeError(`glyph ${JSON.stringify(input.text)} exceeds bounded scratch space`)
  }

  private bitmapFromImage(image: ImageData, bounds: PixelBounds, padding: number): GlyphBitmap {
    const kind = glyphKind(image, bounds)
    return {
      height: bounds.bottom - bounds.top + 1,
      kind,
      offsetX: bounds.left - padding,
      offsetY: bounds.top - padding,
      pixels: copyPixels(image, bounds, kind),
      width: bounds.right - bounds.left + 1,
    }
  }
}
