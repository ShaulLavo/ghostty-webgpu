import { expect, it } from 'vitest'
import type { GlyphBitmap, GlyphRasterizationInput } from './types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { CanvasGlyphRasterizer } from './canvas-rasterizer.js'

function input(
  text: string,
  cellSpan = 1,
  overrides: Partial<GlyphRasterizationInput> = {},
): GlyphRasterizationInput {
  return { cellSpan, italic: false, text, weight: 'normal', ...overrides }
}

function requireBitmap(bitmap: GlyphBitmap | undefined): GlyphBitmap {
  expect(bitmap).toBeDefined()
  return bitmap!
}

function lastCoveredCellRow(bitmap: GlyphBitmap): number {
  return bitmap.offsetY + bitmap.height - 1
}

interface FittedFontOptions {
  boldWeight?: number
  letterSpacing?: number
  lineHeight?: number
  pixelRatio?: number
  weight?: number
}

function createRasterizer(options: FittedFontOptions = {}): CanvasGlyphRasterizer {
  return new CanvasGlyphRasterizer({ font: fittedFont(options) })
}

function fittedFont(options: FittedFontOptions = {}): TerminalFittedFont {
  const pixelRatio = options.pixelRatio ?? 1
  const deviceCharWidth = Math.floor(20 * pixelRatio)
  const deviceCharHeight = Math.ceil(30 * pixelRatio)
  const deviceSpacing = Math.round((options.letterSpacing ?? 0) * pixelRatio)
  const deviceCellWidth = deviceCharWidth + deviceSpacing
  const lineHeight = options.lineHeight ?? 4 / 3
  const deviceCellHeight = Math.floor(deviceCharHeight * lineHeight)
  const charTop = lineHeight === 1 ? 0 : Math.round((deviceCellHeight - deviceCharHeight) / 2)
  return Object.freeze({
    charLeft: Math.floor(deviceSpacing / 2),
    charTop,
    cssCellHeight: deviceCellHeight / pixelRatio,
    cssCellWidth: deviceCellWidth / pixelRatio,
    deviceBaseline: charTop + Math.ceil(24 * pixelRatio),
    deviceCellHeight,
    deviceCellWidth,
    deviceCharHeight,
    deviceCharWidth,
    pixelRatio,
    settings: Object.freeze({
      boldWeight: options.boldWeight ?? 700,
      family: 'monospace',
      letterSpacing: options.letterSpacing ?? 0,
      lineHeight,
      size: 30,
      weight: options.weight ?? 400,
    }),
  })
}

function coverage(bitmap: GlyphBitmap): number {
  if (bitmap.kind === 'grayscale') {
    return bitmap.pixels.reduce((total, value) => total + value, 0)
  }
  let total = 0
  for (let offset = 3; offset < bitmap.pixels.length; offset += 4) {
    total += bitmap.pixels[offset] ?? 0
  }
  return total
}

it('keeps alphabetic glyphs on one stable cell-relative baseline', () => {
  const rasterizer = createRasterizer()
  const rows = ['A', 'M', 'a', '1'].map((text) =>
    lastCoveredCellRow(requireBitmap(rasterizer.rasterize(input(text)))),
  )
  const spread = Math.max(...rows) - Math.min(...rows)

  expect(spread).toBeLessThanOrEqual(1)
})

it('crops actual ink, preserves span identity, and skips empty glyphs', () => {
  const rasterizer = createRasterizer()
  const narrow = requireBitmap(rasterizer.rasterize(input('M')))
  const wide = requireBitmap(rasterizer.rasterize(input('界', 2)))

  expect(narrow.width).toBeLessThan(20)
  expect(narrow.height).toBeLessThan(40)
  expect(wide.width).toBeLessThan(40)
  expect(rasterizer.rasterize(input('界', 2))).toBe(wide)
  expect(rasterizer.rasterize(input('界'))).not.toBe(wide)
  expect(rasterizer.rasterize(input(' '))).toBeUndefined()
})

it('separates regular, bold, italic, and bold-italic cache identities', () => {
  const rasterizer = createRasterizer()
  const regular = requireBitmap(rasterizer.rasterize(input('j')))
  const bold = requireBitmap(rasterizer.rasterize(input('j', 1, { weight: 'bold' })))
  const italic = requireBitmap(rasterizer.rasterize(input('j', 1, { italic: true })))
  const boldItalic = requireBitmap(
    rasterizer.rasterize(input('j', 1, { italic: true, weight: 'bold' })),
  )

  expect(new Set([regular, bold, italic, boldItalic]).size).toBe(4)
  expect(rasterizer.rasterize(input('j', 1, { italic: true }))).toBe(italic)
  expect(italic.offsetX).toBeLessThanOrEqual(regular.offsetX)
})

it('stores monochrome coverage in one byte and actual colored output in RGBA', () => {
  const rasterizer = createRasterizer()
  const grayscale = requireBitmap(rasterizer.rasterize(input('A')))
  const emoji = requireBitmap(rasterizer.rasterize(input('🧪', 2)))

  expect(grayscale.kind).toBe('grayscale')
  expect(grayscale.pixels).toHaveLength(grayscale.width * grayscale.height)
  expect(emoji.kind).toBe('color')
  expect(emoji.pixels).toHaveLength(emoji.width * emoji.height * 4)
})

it('uses configured numeric regular and bold weights while italic remains cell-driven', () => {
  const rasterizer = createRasterizer({ boldWeight: 900, weight: 300 })
  const regular = requireBitmap(rasterizer.rasterize(input('M')))
  const bold = requireBitmap(rasterizer.rasterize(input('M', 1, { weight: 'bold' })))
  const boldItalic = requireBitmap(
    rasterizer.rasterize(input('M', 1, { italic: true, weight: 'bold' })),
  )

  expect(coverage(bold)).toBeGreaterThan(coverage(regular))
  expect(coverage(boldItalic)).toBeGreaterThan(0)
})

it('places glyphs from fitted positive and safe negative letter spacing at every target DPR', () => {
  for (const pixelRatio of [1, 1.25, 1.5, 2, 2.2]) {
    const regular = requireBitmap(createRasterizer({ pixelRatio }).rasterize(input('M')))
    const positive = requireBitmap(
      createRasterizer({ letterSpacing: 1, pixelRatio }).rasterize(input('M')),
    )
    const negative = requireBitmap(
      createRasterizer({ letterSpacing: -1, pixelRatio }).rasterize(input('M')),
    )

    expect(positive.offsetX).toBeGreaterThanOrEqual(regular.offsetX)
    expect(negative.offsetX).toBeLessThanOrEqual(regular.offsetX)
    expect(coverage(positive)).toBeGreaterThan(0)
    expect(coverage(negative)).toBeGreaterThan(0)
  }
})
