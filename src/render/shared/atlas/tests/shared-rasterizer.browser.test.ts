import { expect, it } from 'vitest'
import { testFontUrl } from '../../../../tests/fonts.js'
import { fittedFont } from '../../../webgl/tests/fixture.js'
import { acquireGlyphRasterizer, releaseGlyphRasterizer } from '../shared-rasterizer.js'

it('shares a rasterizer only while the fitted font and the loaded faces match', async ({
  onTestFinished,
}) => {
  const font = fittedFont()
  const first = acquireGlyphRasterizer(font)
  const second = acquireGlyphRasterizer(font)
  const larger = acquireGlyphRasterizer({ ...font, settings: { ...font.settings, size: 30 } })
  onTestFinished(() => [first, second, larger].forEach(releaseGlyphRasterizer))
  expect(second).toBe(first)
  expect(larger).not.toBe(first)

  const face = new FontFace(font.settings.family, `url(${testFontUrl})`)
  await face.load()
  document.fonts.add(face)
  onTestFinished(() => {
    document.fonts.delete(face)
  })
  const afterLoad = acquireGlyphRasterizer(font)
  onTestFinished(() => releaseGlyphRasterizer(afterLoad))
  expect(afterLoad).not.toBe(first)
})
