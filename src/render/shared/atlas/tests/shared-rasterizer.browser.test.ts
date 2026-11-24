import { expect, it } from 'vitest'
import { testFontUrl } from '../../../../tests/fonts.js'
import { fittedFont } from '../../../webgl/tests/fixture.js'
import { acquireGlyphRasterizer, releaseGlyphRasterizer } from '../shared-rasterizer.js'

it('shares a rasterizer only while the fitted font and the loaded faces match', async ({
  onTestFinished,
}) => {
  const canvas = document.createElement('canvas')
  const font = fittedFont()
  const first = acquireGlyphRasterizer(font, canvas)
  const second = acquireGlyphRasterizer(font, canvas)
  const larger = acquireGlyphRasterizer(
    { ...font, settings: { ...font.settings, size: 30 } },
    canvas,
  )
  onTestFinished(() => [first, second, larger].forEach(releaseGlyphRasterizer))
  expect(second).toBe(first)
  expect(larger).not.toBe(first)

  const face = new FontFace(font.settings.family, `url(${testFontUrl})`)
  await face.load()
  document.fonts.add(face)
  onTestFinished(() => {
    document.fonts.delete(face)
  })
  const afterLoad = acquireGlyphRasterizer(font, canvas)
  onTestFinished(() => releaseGlyphRasterizer(afterLoad))
  expect(afterLoad).not.toBe(first)
})
