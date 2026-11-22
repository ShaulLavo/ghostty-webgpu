import type { AtlasKind, GlyphBitmap, GlyphRasterizationInput, GlyphRasterizer } from './types.js'
import type { TerminalFittedFont } from '../../../term/types.js'
import { glyphConstraintWidth, glyphKey } from './key.js'
import {
  constrainGlyph,
  glyphConstraint,
  isEmojiPresentationText,
  type GlyphConstraint,
} from './glyph-constraints.js'
import { drawSprite, spriteCodepoint } from './sprites.js'

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

interface GlyphLayout {
  readonly cellWidth: number
  readonly constraint: GlyphConstraint | undefined
  readonly constraintWidth: 1 | 2
  readonly sprite: number | undefined
}

const colorChannelTolerance = 2
const maxBitmapCacheBytes = 4 * 1_024 * 1_024
const maxBitmapCacheEntries = 4_096
const maxScratchAttempts = 3

function validateInput(input: GlyphRasterizationInput): GlyphRasterizationInput {
  if (!Number.isSafeInteger(input.cellSpan) || input.cellSpan <= 0) {
    throw new RangeError('cellSpan must be a positive integer')
  }
  if (
    input.constraintWidth !== undefined &&
    input.constraintWidth !== 1 &&
    input.constraintWidth !== 2
  ) {
    throw new RangeError('constraintWidth must be 1 or 2')
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
  const { data, width, height } = image
  let left = width
  let right = -1
  let top = height
  let bottom = -1
  for (let y = 0, alpha = 3; y < height; y += 1, alpha += width * 4) {
    let rowLeft = 0
    while (rowLeft < width && data[alpha + rowLeft * 4] === 0) rowLeft += 1
    if (rowLeft === width) continue
    let rowRight = width - 1
    while (rowRight > rowLeft && data[alpha + rowRight * 4] === 0) rowRight -= 1
    left = Math.min(left, rowLeft)
    right = Math.max(right, rowRight)
    top = Math.min(top, y)
    bottom = y
  }
  if (bottom < 0) return undefined
  return { bottom, left, right, top }
}

function touchesScratchEdge(bounds: PixelBounds, width: number, height: number): boolean {
  return (
    bounds.left === 0 ||
    bounds.top === 0 ||
    bounds.right === width - 1 ||
    bounds.bottom === height - 1
  )
}

function hasIntrinsicColor(image: ImageData, ink: 0 | 255, bounds?: PixelBounds): boolean {
  const { data, width, height } = image
  const left = bounds?.left ?? 0
  const bottom = bounds?.bottom ?? height - 1
  const rowBytes = ((bounds?.right ?? width - 1) - left + 1) * 4
  for (let y = bounds?.top ?? 0; y <= bottom; y += 1) {
    const start = (y * width + left) * 4
    const end = start + rowBytes
    for (let offset = start; offset < end; offset += 4) {
      if (data[offset + 3] === 0) continue
      // XOR with 0 or 255 is the distance from black or white.
      if (
        (data[offset]! ^ ink) > colorChannelTolerance ||
        (data[offset + 1]! ^ ink) > colorChannelTolerance ||
        (data[offset + 2]! ^ ink) > colorChannelTolerance
      )
        return true
    }
  }
  return false
}

function copyPixels(image: ImageData, bounds: PixelBounds, kind: AtlasKind): Uint8Array {
  const width = bounds.right - bounds.left + 1
  const height = bounds.bottom - bounds.top + 1
  const { data } = image
  const pixels = new Uint8Array(width * height * (kind === 'grayscale' ? 1 : 4))
  const start = bounds.top * image.width + bounds.left
  if (kind === 'color') {
    const source = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4)
    copyPixelRows(source, new Uint32Array(pixels.buffer), start, image.width, width)
    return pixels
  }
  for (let row = 0, target = 0; row < height; row += 1) {
    const alpha = (start + row * image.width) * 4 + 3
    for (let offset = alpha; offset < alpha + width * 4; offset += 4) {
      pixels[target++] = data[offset]!
    }
  }
  return pixels
}

function copyPixelRows(
  source: Uint32Array,
  target: Uint32Array,
  start: number,
  stride: number,
  width: number,
): void {
  for (let offset = 0; offset < target.length; offset += width, start += stride) {
    for (let column = 0; column < width; column += 1) {
      target[offset + column] = source[start + column]!
    }
  }
}

export class CanvasGlyphRasterizer implements GlyphRasterizer {
  private bitmapCacheBytes = 0
  private readonly bitmaps = new Map<string, GlyphBitmap | undefined>()
  private readonly canvas: ScratchCanvas
  private readonly capHeight: number
  private readonly context: ScratchContext
  private readonly font: TerminalFittedFont
  private readonly initialPadding: number

  constructor(options: CanvasGlyphRasterizerOptions) {
    this.font = options.font
    this.canvas = createScratchCanvas()
    this.initialPadding = Math.ceil(
      Math.max(this.font.deviceCellHeight, this.font.settings.size * this.font.pixelRatio),
    )
    const context = requireContext(this.canvas)
    this.context = context
    context.font = fontString(this.font, { italic: false, weight: 'normal' })
    this.capHeight =
      context.measureText('H').actualBoundingBoxAscent || this.font.deviceCharHeight * 0.75
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

  private glyphLayout(input: GlyphRasterizationInput): GlyphLayout {
    const constraintWidth = glyphConstraintWidth(input)
    const sprite = spriteCodepoint(input.text, this.font)
    const constraint =
      sprite === undefined && !isEmojiPresentationText(input.text)
        ? glyphConstraint(input.text.codePointAt(0) ?? 0)
        : undefined
    const cells = constraint ? Math.max(input.cellSpan, constraintWidth) : input.cellSpan
    return { cellWidth: this.font.deviceCellWidth * cells, constraint, constraintWidth, sprite }
  }

  private draw(
    input: GlyphRasterizationInput,
    layout: GlyphLayout,
    padding: number,
    ink: string,
    width: number,
    height: number,
  ): void {
    const { context, font } = this
    const { cellWidth, constraint, constraintWidth, sprite } = layout
    context.clearRect(0, 0, width, height)
    context.font = fontString(font, input)
    context.textAlign = 'center'
    context.textBaseline = 'alphabetic'
    context.fillStyle = ink
    const characterWidth = cellWidth - (font.deviceCellWidth - font.deviceCharWidth)
    const drawX = padding + font.charLeft + characterWidth / 2
    const drawY = padding + font.deviceBaseline
    const clip = font.settings.lineHeight < 1
    if (!clip && sprite === undefined && !constraint) {
      context.fillText(input.text, drawX, drawY)
      return
    }
    context.save()
    try {
      if (clip) {
        context.beginPath()
        context.rect(padding, padding, cellWidth, font.deviceCellHeight)
        context.clip()
      }
      if (sprite !== undefined) {
        context.strokeStyle = ink
        context.translate(padding, padding)
        drawSprite(context, sprite, font, input.cellSpan)
        return
      }
      if (constraint) {
        this.drawConstrained(context, input, constraint, constraintWidth, drawX, drawY, padding)
        return
      }
      context.fillText(input.text, drawX, drawY)
    } finally {
      context.restore()
    }
  }

  private drawConstrained(
    context: ScratchContext,
    input: GlyphRasterizationInput,
    constraint: GlyphConstraint,
    constraintWidth: 1 | 2,
    drawX: number,
    drawY: number,
    padding: number,
  ): void {
    const measured = context.measureText(input.text)
    const left = drawX - measured.actualBoundingBoxLeft
    const bottom = drawY + measured.actualBoundingBoxDescent
    const cellHeight = this.font.deviceCellHeight
    const original = {
      height: measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent,
      width: measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight,
      x: left - padding,
      y: cellHeight - (bottom - padding),
    }
    if (original.width < 0.25 || original.height < 0.25) return
    const constrained = constrainGlyph(
      original,
      constraint,
      {
        cellHeight,
        cellWidth: this.font.deviceCellWidth,
        faceHeight: this.font.deviceCharHeight,
        faceWidth: this.font.deviceCharWidth,
        faceY: cellHeight - this.font.charTop - this.font.deviceCharHeight,
        iconHeight: this.font.deviceCharHeight,
        iconHeightSingle: (2 * this.capHeight + this.font.deviceCharHeight) / 3,
      },
      constraintWidth,
    )
    if (constraint.size !== 'stretch' && this.font.deviceCharWidth < this.font.deviceCellWidth) {
      constrained.x += Math.round((this.font.deviceCellWidth - this.font.deviceCharWidth) / 2)
    }
    if (constraint.size === 'stretch') {
      context.beginPath()
      context.rect(
        padding + constrained.x,
        padding + cellHeight - constrained.y - constrained.height,
        constrained.width,
        constrained.height,
      )
      context.clip()
    }
    context.translate(padding + constrained.x, padding + cellHeight - constrained.y)
    context.scale(constrained.width / original.width, constrained.height / original.height)
    context.fillText(input.text, drawX - left, drawY - bottom)
  }

  private rasterizeUncached(
    input: GlyphRasterizationInput,
    ink: string,
    kind: AtlasKind | undefined,
  ): GlyphBitmap | undefined {
    const layout = this.glyphLayout(input)
    const { canvas, context } = this
    let padding = this.initialPadding
    for (let attempt = 0; attempt < maxScratchAttempts; attempt += 1) {
      const width = Math.ceil(layout.cellWidth + padding * 2)
      const height = Math.ceil(this.font.deviceCellHeight + padding * 2)
      if (width > canvas.width) canvas.width = width
      if (height > canvas.height) canvas.height = height
      this.draw(input, layout, padding, ink, width, height)
      const image = context.getImageData(0, 0, width, height)
      const bounds = alphaBounds(image)
      if (!bounds) return undefined
      if (touchesScratchEdge(bounds, width, height)) {
        padding *= 2
        continue
      }
      const bitmapKind = kind ?? this.detectKind(input, layout, padding, image, bounds)
      return this.bitmapFromImage(image, bounds, padding, bitmapKind)
    }
    throw new RangeError(`glyph ${JSON.stringify(input.text)} exceeds bounded scratch space`)
  }

  private detectKind(
    input: GlyphRasterizationInput,
    layout: GlyphLayout,
    padding: number,
    image: ImageData,
    bounds: PixelBounds,
  ): AtlasKind {
    if (layout.sprite !== undefined) return 'grayscale'
    if (hasIntrinsicColor(image, 255, bounds)) return 'color'
    // The black probe distinguishes intrinsic white from ordinary foreground ink.
    this.draw(input, layout, padding, '#000000', image.width, image.height)
    const probe = this.context.getImageData(
      bounds.left,
      bounds.top,
      bounds.right - bounds.left + 1,
      bounds.bottom - bounds.top + 1,
    )
    return hasIntrinsicColor(probe, 0) ? 'color' : 'grayscale'
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
