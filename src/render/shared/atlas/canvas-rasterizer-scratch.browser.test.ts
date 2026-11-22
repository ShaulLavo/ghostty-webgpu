import { expect, it } from 'vitest'
import { fitTerminalFont } from '../../../dom/fit.js'
import { CanvasGlyphRasterizer } from './canvas-rasterizer.js'
import type { GlyphRasterizationInput } from './types.js'

function input(text: string, cellSpan = 1): GlyphRasterizationInput {
  return {
    cellSpan,
    foreground: { r: 255, g: 255, b: 255 },
    italic: true,
    text,
    weight: 'normal',
  }
}

it('keeps pixels and offsets stable after drawing wider and transformed glyphs', () => {
  const font = fitTerminalFont(
    document,
    {
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: 0.7,
      size: 30,
      weight: 400,
    },
    1,
  )
  const rasterizer = new CanvasGlyphRasterizer({ font })
  expect(rasterizer.rasterize(input('████████', 8))).toBeDefined()
  expect(rasterizer.rasterize(input('█'))).toBeDefined()
  expect(rasterizer.rasterize(input('→'))).toBeDefined()

  const narrow = input('j')
  const bitmap = rasterizer.rasterize(narrow)
  expect(bitmap).toBeDefined()
  expect(bitmap).toEqual(new CanvasGlyphRasterizer({ font }).rasterize(narrow))
  expect(rasterizer.rasterize(input(' '))).toBeUndefined()
})
