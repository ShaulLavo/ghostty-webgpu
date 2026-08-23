import { expect, it } from 'vitest'
import type { GlyphBitmap } from './types.js'
import { CanvasGlyphRasterizer } from './canvas-rasterizer.js'

function lastCoveredRow(bitmap: GlyphBitmap): number {
  for (let row = bitmap.height - 1; row >= 0; row -= 1) {
    const start = row * bitmap.width * 4
    const end = start + bitmap.width * 4
    for (let offset = start + 3; offset < end; offset += 4) {
      if ((bitmap.pixels[offset] ?? 0) > 0) return row
    }
  }
  return -1
}

function createRasterizer(): CanvasGlyphRasterizer {
  return new CanvasGlyphRasterizer({
    cellHeight: 40,
    cellWidth: 20,
    fontFamily: 'monospace',
    fontSize: 30,
  })
}

it('keeps alphabetic glyphs on one stable baseline', () => {
  const rasterizer = createRasterizer()
  const rows = ['A', 'M', 'a', '1'].map((text) => lastCoveredRow(rasterizer.rasterize(text)))
  const spread = Math.max(...rows) - Math.min(...rows)

  expect(spread).toBeLessThanOrEqual(1)
})

it('rasterizes exact device-cell spans without rescaling', () => {
  const rasterizer = createRasterizer()
  const narrow = rasterizer.rasterize('M')
  const wide = rasterizer.rasterize('界', 2)

  expect(narrow).toMatchObject({ height: 40, width: 20 })
  expect(wide).toMatchObject({ height: 40, width: 40 })
  expect(rasterizer.rasterize('界', 2)).toBe(wide)
  expect(rasterizer.rasterize('界')).not.toBe(wide)
})
