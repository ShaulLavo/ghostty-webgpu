import { expect, it } from 'vitest'
import { testFontUrl } from './fonts.js'

it('serves the pinned browser fixture as a loadable WOFF2 font', async () => {
  const response = await fetch(testFontUrl)
  expect(response.status).toBe(200)
  const bytes = new Uint8Array(await response.arrayBuffer())
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('wOF2')
  const face = new FontFace('BrowserFixtureFont', bytes)
  await expect(face.load()).resolves.toBe(face)
})
