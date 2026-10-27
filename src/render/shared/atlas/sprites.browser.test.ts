import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { TerminalFittedFont } from '../../../term/types.js'
import { CanvasGlyphRasterizer } from './canvas-rasterizer.js'
import { readSfntFontMetrics } from '../../../term/font-metrics.js'
import type { TerminalFontMetrics } from '../../../term/types.js'
import { spriteCodepoint, spriteThickness } from './sprites.js'

let fontMetrics: TerminalFontMetrics
let fixtureFace: FontFace | undefined
let fontSha256: string
beforeAll(async () => {
  const response = await fetch(
    new URL('./sprite-fixtures/JetBrainsMono-Regular.ttf', import.meta.url),
  )
  const bytes = await response.arrayBuffer()
  fontSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  const metrics = readSfntFontMetrics(new Uint8Array(bytes))
  if (!metrics) throw new Error('Fixture font has no positive post metric')
  fontMetrics = metrics
  fixtureFace = await new FontFace('SpriteMetricFixture', bytes).load()
  document.fonts.add(fixtureFace)
})
afterAll(() => {
  if (fixtureFace) document.fonts.delete(fixtureFace)
})

function font(
  width: number,
  height: number,
  pixelRatio: number,
  size = height / 1.2,
): TerminalFittedFont {
  const deviceCellWidth = Math.round(width * pixelRatio)
  const deviceCellHeight = Math.round(height * pixelRatio)
  return {
    charLeft: 0,
    charTop: 0,
    cssCellWidth: deviceCellWidth / pixelRatio,
    cssCellHeight: deviceCellHeight / pixelRatio,
    deviceCellWidth,
    deviceCellHeight,
    deviceCharWidth: deviceCellWidth,
    deviceCharHeight: deviceCellHeight,
    deviceBaseline: Math.round(deviceCellHeight * 0.8),
    pixelRatio,
    settings: {
      family: 'SpriteMetricFixture',
      metrics: fontMetrics,
      size,
      weight: 400,
      boldWeight: 700,
      lineHeight: 1.2,
      letterSpacing: 0,
    },
  }
}

for (const [width, height] of [
  [9, 18],
  [13, 27],
  [18, 36],
]) {
  for (const dpr of [1, 1.25, 2]) {
    it(`fills block cells without seams at ${width}x${height} DPR ${dpr}`, () => {
      const fitted = font(width!, height!, dpr)
      const rasterizer = new CanvasGlyphRasterizer({ font: fitted })
      const bitmap = rasterizer.rasterize({
        text: '█',
        cellSpan: 1,
        weight: 'normal',
        italic: false,
        foreground: { r: 255, g: 255, b: 255 },
      })
      expect(bitmap).toBeDefined()
      expect(bitmap!.offsetX).toBe(0)
      expect(bitmap!.offsetY).toBe(0)
      expect(bitmap!.width).toBe(fitted.deviceCellWidth)
      expect(bitmap!.height).toBe(fitted.deviceCellHeight)
      expect(Array.from(bitmap!.pixels).every((value) => value === 255)).toBe(true)
    })
  }
}

interface FixtureCase {
  width: number
  height: number
  thickness: number
  fontSize: number
  span: number
  dpr: number
  tileWidth: number
  tileHeight: number
  file: string
}
interface Manifest {
  font: { sha256: string; unitsPerEm: number; underlineThickness: number }
  revision: string
  codepoints: number[]
  cases: FixtureCase[]
}

async function referenceManifest(): Promise<Manifest> {
  return (await fetch(new URL('./sprite-fixtures/manifest.json', import.meta.url))).json()
}

async function referencePixels(index: number): Promise<ImageData> {
  const image = new Image()
  image.src = new URL(`./sprite-fixtures/case-${index}.png`, import.meta.url).href
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function candidatePixels(
  reference: ImageData,
  fixture: FixtureCase,
  codepoints: readonly number[],
): ImageData {
  const fitted = font(
    fixture.width / fixture.dpr,
    fixture.height / fixture.dpr,
    fixture.dpr,
    fixture.fontSize,
  )
  expect(spriteThickness(fitted)).toBe(fixture.thickness)
  const rasterizer = new CanvasGlyphRasterizer({ font: fitted })
  const result = new ImageData(reference.width, reference.height)
  codepoints.forEach((cp, index) => {
    const bitmap = rasterizer.rasterize({
      text: String.fromCodePoint(cp),
      cellSpan: fixture.span,
      weight: 'normal',
      italic: false,
      foreground: { r: 255, g: 255, b: 255 },
    })
    if (!bitmap) return
    const x =
      (index % 16) * fixture.tileWidth +
      Math.floor((fixture.width * fixture.span) / 4) +
      bitmap.offsetX
    const y =
      Math.floor(index / 16) * fixture.tileHeight + Math.floor(fixture.height / 4) + bitmap.offsetY
    copyBitmap(result, bitmap, x, y)
  })
  return result
}

function copyBitmap(
  target: ImageData,
  bitmap: import('./types.js').GlyphBitmap,
  x: number,
  y: number,
): void {
  for (let row = 0; row < bitmap.height; row++) {
    for (let col = 0; col < bitmap.width; col++) {
      const value =
        bitmap.pixels[(row * bitmap.width + col) * (bitmap.kind === 'color' ? 4 : 1)] ?? 0
      const offset = ((y + row) * target.width + x + col) * 4
      target.data[offset] = value
      target.data[offset + 1] = value
      target.data[offset + 2] = value
      target.data[offset + 3] = 255
    }
  }
}

function covered(image: ImageData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
  return (image.data[(y * image.width + x) * 4] ?? 0) >= 32
}

function nearby(
  image: ImageData,
  x: number,
  y: number,
  tileX: number,
  tileY: number,
  fixture: FixtureCase,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (
        x + dx < tileX ||
        y + dy < tileY ||
        x + dx >= tileX + fixture.tileWidth ||
        y + dy >= tileY + fixture.tileHeight
      )
        continue
      if (covered(image, x + dx, y + dy)) return true
    }
  }
  return false
}

function mismatches(
  reference: ImageData,
  candidate: ImageData,
  fixture: FixtureCase,
  codepoints: readonly number[],
): string[] {
  const failures: string[] = []
  for (let index = 0; index < codepoints.length; index++) {
    const tileX = (index % 16) * fixture.tileWidth
    const tileY = Math.floor(index / 16) * fixture.tileHeight
    const cp = codepoints[index]!
    const exact = !(cp >= 0x256d && cp <= 0x2573) && !(cp >= 0xe0b0 && cp <= 0xe0bf)
    if (tileMismatch(reference, candidate, fixture, tileX, tileY, exact))
      failures.push(`U+${codepoints[index]!.toString(16)}`)
  }
  return failures
}

function tileMismatch(
  reference: ImageData,
  candidate: ImageData,
  fixture: FixtureCase,
  tileX: number,
  tileY: number,
  exact: boolean,
): boolean {
  for (let y = tileY; y < tileY + fixture.tileHeight; y++) {
    for (let x = tileX; x < tileX + fixture.tileWidth; x++) {
      const offset = (y * reference.width + x) * 4
      if (exact && reference.data[offset] !== candidate.data[offset]) return true
      if (!exact && pixelMismatch(reference, candidate, fixture, tileX, tileY, x, y)) return true
    }
  }
  return false
}

function pixelMismatch(
  reference: ImageData,
  candidate: ImageData,
  fixture: FixtureCase,
  tileX: number,
  tileY: number,
  x: number,
  y: number,
): boolean {
  if (covered(reference, x, y) && !nearby(candidate, x, y, tileX, tileY, fixture)) return true
  return covered(candidate, x, y) && !nearby(reference, x, y, tileX, tileY, fixture)
}

it('matches native Ghostty sprite contact sheets within one device pixel', async () => {
  const manifest = await referenceManifest()
  expect(manifest.revision).toBe('7b11f3dca034d8d24369ad3856afe57946d7902a')
  expect(manifest.font.sha256).toBe(fontSha256)
  expect(fontMetrics).toEqual({
    unitsPerEm: manifest.font.unitsPerEm,
    underlineThickness: manifest.font.underlineThickness,
  })
  const failures: string[] = []
  for (const [index, fixture] of manifest.cases.entries()) {
    const reference = await referencePixels(index)
    const candidate = candidatePixels(reference, fixture, manifest.codepoints)
    if (index < 10) await screenshotSheet(reference, candidate, index)
    const different = mismatches(reference, candidate, fixture, manifest.codepoints)
    if (different.length) failures.push(`case ${index}: ${different.join(', ')}`)
  }
  expect(failures).toEqual([])
}, 60_000)

async function screenshotSheet(
  reference: ImageData,
  candidate: ImageData,
  index: number,
): Promise<void> {
  const section = document.createElement('section')
  section.style.cssText = 'display:flex;width:max-content;background:#000;color:#fff;gap:8px'
  for (const [label, pixels] of [
    ['Native Ghostty', reference],
    ['Browser sprites', candidate],
  ] as const) {
    const figure = document.createElement('figure')
    figure.style.margin = '0'
    const caption = document.createElement('figcaption')
    caption.textContent = label
    const canvas = document.createElement('canvas')
    canvas.width = pixels.width
    canvas.height = pixels.height
    canvas.getContext('2d')!.putImageData(pixels, 0, 0)
    figure.append(caption, canvas)
    section.append(figure)
  }
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(reference.width * 2 + 40, reference.height + 80)
  document.body.append(section)
  try {
    await page.screenshot({
      element: section,
      path: `.artifacts/sprites-case-${index}.png`,
      scale: 'css',
    })
  } finally {
    section.remove()
    await page.viewport(viewport.width, viewport.height)
  }
}

it('keeps sprite geometry independent of font family, bold and italic', () => {
  const fitted = font(13, 27, 1.25)
  const first = new CanvasGlyphRasterizer({ font: fitted })
  const second = new CanvasGlyphRasterizer({
    font: { ...fitted, settings: { ...fitted.settings, family: 'serif' } },
  })
  for (const text of ['┼', '▚', '⣿', '🬀', '\ue0b0']) {
    const input = {
      text,
      cellSpan: 1,
      weight: 'normal',
      italic: false,
      foreground: { r: 255, g: 255, b: 255 },
    } as const
    const expected = first.rasterize(input)
    expect(second.rasterize({ ...input, weight: 'bold', italic: true })).toEqual(expected)
  }
})

it('keeps thickness-dependent sprites on the font path when post metrics are unavailable', () => {
  const fitted = font(9, 18, 1)
  const { metrics: _metrics, ...settings } = fitted.settings
  const unknown = { ...fitted, settings }
  expect(spriteThickness(unknown)).toBeUndefined()
  const fill = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, 'fillText')
  try {
    new CanvasGlyphRasterizer({ font: unknown }).rasterize({
      text: '║',
      cellSpan: 1,
      weight: 'normal',
      italic: false,
      foreground: { r: 255, g: 255, b: 255 },
    })
    expect(fill).toHaveBeenCalled()
  } finally {
    fill.mockRestore()
  }
  for (const text of ['─', '║', '\ue0b1', '\ue0b5'])
    expect(spriteCodepoint(text, unknown)).toBeUndefined()
  for (const text of ['█', '⣿', '🬀', '\ue0b0']) expect(spriteCodepoint(text, unknown)).toBeDefined()
})
