import { afterAll, beforeAll, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import type { TerminalFittedFont } from '../../../term/types.js'
import { CanvasGlyphRasterizer } from './canvas-rasterizer.js'
import type { GlyphBitmap, GlyphRasterizationInput } from './types.js'

let fixtureFace: FontFace | undefined
let fontSha256: string

beforeAll(async () => {
  const response = await fetch(
    new URL('./constraint-fixtures/JetBrainsMonoNerdFont-Regular.ttf', import.meta.url),
  )
  const bytes = await response.arrayBuffer()
  fontSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  fixtureFace = await new FontFace('GlyphConstraintFixture', bytes).load()
  document.fonts.add(fixtureFace)
})

afterAll(() => {
  if (fixtureFace) document.fonts.delete(fixtureFace)
})

function font(pixelRatio: number, width = 12, height = 24, size = 20): TerminalFittedFont {
  const deviceCellWidth = Math.round(width * pixelRatio)
  const deviceCellHeight = Math.round(height * pixelRatio)
  return {
    charLeft: 0,
    charTop: 0,
    cssCellWidth: width,
    cssCellHeight: height,
    deviceBaseline: Math.round(deviceCellHeight * 0.8),
    deviceCellHeight,
    deviceCellWidth,
    deviceCharHeight: deviceCellHeight,
    deviceCharWidth: deviceCellWidth,
    pixelRatio,
    settings: {
      boldWeight: 700,
      family: 'GlyphConstraintFixture',
      letterSpacing: 0,
      lineHeight: 1,
      size,
      weight: 400,
    },
  }
}

function input(text: string, constraintWidth: 1 | 2): GlyphRasterizationInput {
  return {
    cellSpan: 1,
    constraintWidth,
    foreground: { r: 255, g: 255, b: 255 },
    italic: false,
    text,
    weight: 'normal',
  }
}

it('keeps neighbor widths in the rasterizer cache identity', () => {
  const rasterizer = new CanvasGlyphRasterizer({ font: font(1) })
  const single = rasterizer.rasterize(input('', 1))
  const available = rasterizer.rasterize(input('', 2))

  expect(single).toBeDefined()
  expect(available).toBeDefined()
  expect(available).not.toBe(single)
})

it('stretches a Nerd Font powerline glyph to its available cell', () => {
  for (const pixelRatio of [1, 2]) {
    const fitted = font(pixelRatio)
    const bitmap = new CanvasGlyphRasterizer({ font: fitted }).rasterize(input('', 1))

    expect(bitmap).toBeDefined()
    expect(bitmap!.offsetX).toBeGreaterThanOrEqual(0)
    expect(bitmap!.offsetY).toBeGreaterThanOrEqual(0)
    expect(bitmap!.offsetX + bitmap!.width).toBeLessThanOrEqual(fitted.deviceCellWidth)
    expect(bitmap!.offsetY + bitmap!.height).toBeLessThanOrEqual(fitted.deviceCellHeight)
    expect(bitmap!.width).toBeGreaterThanOrEqual(fitted.deviceCellWidth - 1)
    expect(bitmap!.height).toBeGreaterThanOrEqual(fitted.deviceCellHeight - 2)
  }
})

interface FixtureCase {
  cellBaseline: number
  cellHeight: number
  cellWidth: number
  constraintWidth: 1 | 2
  dpr: number
  file: string
  fontSize: number
  height: number
  tileHeight: number
  tileWidth: number
  width: number
}

interface Manifest {
  cases: FixtureCase[]
  codepoints: number[]
  font: { sha256: string }
  revision: string
}

async function referenceManifest(): Promise<Manifest> {
  const response = await fetch(new URL('./constraint-fixtures/manifest.json', import.meta.url))
  return response.json()
}

async function referencePixels(file: string): Promise<ImageData> {
  const image = new Image()
  image.src = new URL(`./constraint-fixtures/${file}`, import.meta.url).href
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function copyBitmap(target: ImageData, bitmap: GlyphBitmap, x: number, y: number): void {
  for (let row = 0; row < bitmap.height; row += 1) {
    for (let column = 0; column < bitmap.width; column += 1) {
      const targetX = x + column
      const targetY = y + row
      if (targetX < 0 || targetY < 0 || targetX >= target.width || targetY >= target.height) {
        continue
      }
      const source = (row * bitmap.width + column) * (bitmap.kind === 'color' ? 4 : 1)
      const destination = (targetY * target.width + targetX) * 4
      const value = bitmap.pixels[source] ?? 0
      target.data[destination] = value
      target.data[destination + 1] = value
      target.data[destination + 2] = value
      target.data[destination + 3] = 255
    }
  }
}

function candidatePixels(
  reference: ImageData,
  fixture: FixtureCase,
  codepoints: readonly number[],
): ImageData {
  const rasterizer = new CanvasGlyphRasterizer({
    font: font(fixture.dpr, fixture.width, fixture.height, fixture.fontSize),
  })
  const result = new ImageData(reference.width, reference.height)
  codepoints.forEach((cp, index) => {
    const bitmap = rasterizer.rasterize(input(String.fromCodePoint(cp), fixture.constraintWidth))
    if (!bitmap) return
    const x = (index % 8) * fixture.tileWidth + 8 + bitmap.offsetX
    const y = Math.floor(index / 8) * fixture.tileHeight + 8 + bitmap.offsetY
    copyBitmap(result, bitmap, x, y)
  })
  return result
}

function mismatchMetrics(reference: ImageData, candidate: ImageData) {
  let delta = 0
  let different = 0
  let maximum = 0
  for (let offset = 0; offset < reference.data.length; offset += 4) {
    const difference = Math.abs((reference.data[offset] ?? 0) - (candidate.data[offset] ?? 0))
    delta += difference
    maximum = Math.max(maximum, difference)
    if (difference > 32) different += 1
  }
  const pixels = reference.width * reference.height
  return { different: different / pixels, maximum, mean: delta / pixels }
}

async function screenshotSheet(reference: ImageData, candidate: ImageData, index: number) {
  const section = document.createElement('section')
  section.style.cssText = 'display:flex;width:max-content;background:#000;color:#fff;gap:8px'
  for (const [label, pixels] of [
    ['Native Ghostty FreeType', reference],
    ['Browser constraints', candidate],
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
      path: `.artifacts/glyph-constraints-case-${index}.png`,
      scale: 'css',
    })
  } finally {
    section.remove()
    await page.viewport(viewport.width, viewport.height)
  }
}

it('leaves ordinary text unchanged by symbol constraint context', () => {
  const rasterizer = new CanvasGlyphRasterizer({ font: font(2) })
  const ordinary = rasterizer.rasterize(input('A', 1))
  const withNeighborWidth = rasterizer.rasterize(input('A', 2))

  expect(withNeighborWidth).toEqual(ordinary)
  expect(rasterizer.rasterize({ ...input('A', 1), constraintWidth: undefined })).toBe(ordinary)
})

it('matches native FreeType glyph constraint contact sheets', async () => {
  const manifest = await referenceManifest()
  expect(manifest.revision).toBe('7b11f3dca034d8d24369ad3856afe57946d7902a')
  expect(manifest.font.sha256).toBe(fontSha256)
  const failures: string[] = []
  for (const [index, fixture] of manifest.cases.entries()) {
    const reference = await referencePixels(fixture.file)
    const candidate = candidatePixels(reference, fixture, manifest.codepoints)
    await screenshotSheet(reference, candidate, index)
    const mismatch = mismatchMetrics(reference, candidate)
    if (mismatch.different > 0.1 || mismatch.mean > 15) {
      failures.push(`case ${index}: ${JSON.stringify(mismatch)}`)
    }
  }
  expect(failures).toEqual([])
}, 60_000)
