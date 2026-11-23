import { afterAll, beforeAll, expect, it } from 'vitest'
import { CanvasGlyphRasterizer } from '../canvas-rasterizer.js'
import { fittedFont, rgb } from '../../../webgl/tests/fixture.js'

const detachedFont = new FontFace(
  'Detached Contour',
  `url(${new URL('../../../tests/fixtures/detached-contour.ttf', import.meta.url).href})`,
)

beforeAll(async () => {
  document.fonts.add(await detachedFont.load())
})
afterAll(() => {
  document.fonts.delete(detachedFont)
})

it('keeps a detached contour that sits above the cell without touching the scratch edge', () => {
  const font = fittedFont()
  const rasterizer = new CanvasGlyphRasterizer({
    font: { ...font, settings: { ...font.settings, family: '"Detached Contour"' } },
  })
  const bitmap = rasterizer.rasterize({
    cellSpan: 1,
    foreground: rgb(255, 255, 255),
    italic: false,
    text: 'D',
    weight: 'normal',
  })!
  // At 20 px the mark spans 30.4 to 32.4 px above the baseline, 18 px below the cell top.
  expect(bitmap.offsetY).toBeLessThanOrEqual(-14)
  expect(bitmap.offsetY + bitmap.height).toBeGreaterThanOrEqual(font.deviceBaseline)
  const top = Array.from(bitmap.pixels.subarray(0, bitmap.width))
  const middle = (font.deviceBaseline - 12 - bitmap.offsetY) * bitmap.width
  const gap = Array.from(bitmap.pixels.subarray(middle, middle + bitmap.width))
  expect(Math.max(...top)).toBeGreaterThan(0)
  expect(Math.max(...gap)).toBe(0)
})
