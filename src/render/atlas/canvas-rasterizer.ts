import type { AtlasKind, GlyphBitmap, GlyphRasterizationInput, GlyphRasterizer } from './types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { glyphKey } from './key.js'

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
const maxBitmapCacheBytes = 4 * 1_024 * 1_024
const maxBitmapCacheEntries = 4_096
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
  const foreground = input.foreground
  if (
    !foreground ||
    !validColorChannel(foreground.r) ||
    !validColorChannel(foreground.g) ||
    !validColorChannel(foreground.b)
  ) {
    throw new RangeError('foreground must contain finite RGB channels from 0 to 255')
  }
  return input
}

function validColorChannel(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 255
}

function bitmapBytes(key: string, bitmap: GlyphBitmap | undefined): number {
  return key.length * 2 + (bitmap?.pixels.byteLength ?? 0)
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

function hasIntrinsicColor(image: ImageData, bounds: PixelBounds, ink: 0 | 255): boolean {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    if (rowContainsIntrinsicColor(image, bounds, y, ink)) return true
  }
  return false
}

function rowContainsIntrinsicColor(
  image: ImageData,
  bounds: PixelBounds,
  row: number,
  ink: 0 | 255,
): boolean {
  for (let x = bounds.left; x <= bounds.right; x += 1) {
    const offset = (row * image.width + x) * 4
    const alpha = image.data[offset + 3] ?? 0
    if (alpha === 0) continue
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    const difference = Math.max(Math.abs(red - ink), Math.abs(green - ink), Math.abs(blue - ink))
    if (difference > colorChannelTolerance) return true
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
  private bitmapCacheBytes = 0
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
    const bitmap = this.rasterizeCached(input, glyphKey(input, 'grayscale'))
    if (bitmap?.kind !== 'color') return bitmap
    const { r, g, b } = input.foreground
    if (r === 255 && g === 255 && b === 255) return bitmap
    // RGBA glyphs can mix fixed colors with currentColor layers, so their brush is part of the key.
    return this.rasterizeCached(input, glyphKey(input, 'color'), `rgb(${r}, ${g}, ${b})`, 'color')
  }

  private rasterizeCached(
    input: GlyphRasterizationInput,
    key: string,
    ink = '#ffffff',
    kind?: AtlasKind,
  ): GlyphBitmap | undefined {
    const cached = this.bitmaps.get(key)
    if (cached !== undefined || this.bitmaps.has(key)) {
      // Defer recency bookkeeping until the cache approaches either retention limit.
      if (
        this.bitmaps.size > maxBitmapCacheEntries / 2 ||
        this.bitmapCacheBytes > maxBitmapCacheBytes / 2
      ) {
        this.bitmaps.delete(key)
        this.bitmaps.set(key, cached)
      }
      return cached
    }
    const bitmap = input.text.length === 0 ? undefined : this.rasterizeUncached(input, ink, kind)
    this.cacheBitmap(key, bitmap)
    return bitmap
  }

  private cacheBitmap(key: string, bitmap: GlyphBitmap | undefined): void {
    const bytes = bitmapBytes(key, bitmap)
    if (bytes > maxBitmapCacheBytes) return
    for (const [cachedKey, cachedBitmap] of this.bitmaps) {
      const fits = this.bitmapCacheBytes + bytes <= maxBitmapCacheBytes
      if (this.bitmaps.size < maxBitmapCacheEntries && fits) break
      this.bitmaps.delete(cachedKey)
      this.bitmapCacheBytes -= bitmapBytes(cachedKey, cachedBitmap)
    }
    this.bitmaps.set(key, bitmap)
    this.bitmapCacheBytes += bytes
  }

  private configure(input: Pick<GlyphRasterizationInput, 'italic' | 'weight'>): ScratchContext {
    const context = requireContext(this.canvas)
    context.font = fontString(this.font, input)
    context.textAlign = 'center'
    context.textBaseline = 'alphabetic'
    return context
  }

  private draw(input: GlyphRasterizationInput, padding: number, ink = '#ffffff'): ImageData {
    const cellWidth = this.font.deviceCellWidth * input.cellSpan
    const deviceSpacing = this.font.deviceCellWidth - this.font.deviceCharWidth
    const characterWidth = cellWidth - deviceSpacing
    this.canvas.width = Math.ceil(cellWidth + padding * 2)
    this.canvas.height = Math.ceil(this.font.deviceCellHeight + padding * 2)
    const context = this.configure(input)
    context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    context.fillStyle = ink
    const drawX = padding + this.font.charLeft + characterWidth / 2
    context.fillText(input.text, drawX, padding + this.font.deviceBaseline)
    return context.getImageData(0, 0, this.canvas.width, this.canvas.height)
  }

  private rasterizeUncached(
    input: GlyphRasterizationInput,
    ink: string,
    kind: AtlasKind | undefined,
  ): GlyphBitmap | undefined {
    let padding = this.initialPadding
    for (let attempt = 0; attempt < maxScratchAttempts; attempt += 1) {
      const image = this.draw(input, padding, ink)
      const bounds = alphaBounds(image)
      if (!bounds) return undefined
      if (touchesScratchEdge(bounds, image.width, image.height)) {
        padding *= 2
        continue
      }
      // Intrinsically gray glyphs need RGBA too; the black probe also identifies white color glyphs.
      const bitmapKind =
        kind ??
        (hasIntrinsicColor(image, bounds, 255) ||
        hasIntrinsicColor(this.draw(input, padding, '#000000'), bounds, 0)
          ? 'color'
          : 'grayscale')
      return this.bitmapFromImage(image, bounds, padding, bitmapKind)
    }
    throw new RangeError(`glyph ${JSON.stringify(input.text)} exceeds bounded scratch space`)
  }

  private bitmapFromImage(
    image: ImageData,
    bounds: PixelBounds,
    padding: number,
    kind: AtlasKind,
  ): GlyphBitmap {
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
