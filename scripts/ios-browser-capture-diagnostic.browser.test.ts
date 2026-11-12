import { afterEach, describe, expect, test } from 'vitest'
import { page } from 'vitest/browser'
import type {} from '@vitest/browser-playwright'
import { pixel } from '../src/render/webgl/tests/fixture.js'
import { captureCanvas } from './ios-browser-capture-fixture.ts'
import { captureDiagnosticBands } from './ios-browser-capture-diagnostic-fixture.ts'

const originalBody = document.body.style.cssText
afterEach(() => {
  document.querySelector('#capture-diagnostic')?.remove()
  document.querySelector('#capture-control')?.remove()
  document.body.style.cssText = originalBody
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
})

describe('native capture diagnostic', () => {
  test('acquires asymmetric bands and device color detail', async () => {
    captureDiagnosticBands()
    const target = captureCanvas({ left: 30.5, top: 30.5 })
    const source = await page.screenshot({ element: target, scale: 'device', save: false })
    const image = new Image()
    image.src = `data:image/png;base64,${source}`
    await image.decode()
    expect([image.naturalWidth, image.naturalHeight]).toEqual([129, 81])
    const decoded = document.createElement('canvas')
    decoded.width = image.naturalWidth
    decoded.height = image.naturalHeight
    const context = decoded.getContext('2d')!
    context.drawImage(image, 0, 0)
    const pixels = new Uint8Array(context.getImageData(0, 0, decoded.width, decoded.height).data)
    const inset = 1.5
    const patches = [
      { x: 13, y: 13, rgba: [49, 90, 155, 255] },
      { x: 29, y: 13, rgba: [128, 128, 128, 255] },
    ]
    for (const { x, y, rgba } of patches)
      expect(
        pixel(pixels, decoded.width, Math.floor(inset + x * 3), Math.floor(inset + y * 3)),
      ).toEqual(rgba)
    const edges = [
      { x: 4, y: 31, rgba: [255, 0, 0, 255] },
      { x: 31, y: 4, rgba: [0, 255, 0, 255] },
      { x: 124, y: 31, rgba: [0, 0, 255, 255] },
      { x: 31, y: 76, rgba: [255, 0, 255, 255] },
    ]
    for (const { x, y, rgba } of edges) expect(pixel(pixels, decoded.width, x, y)).toEqual(rgba)
    expect(pixel(pixels, decoded.width, 0, 0)).toEqual([255, 255, 255, 255])
  }, 15000)
})
