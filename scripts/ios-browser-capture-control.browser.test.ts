import { afterEach, describe, expect, test } from 'vitest'
import { page } from 'vitest/browser'
import type {} from '@vitest/browser-playwright'
import { displayedPixels, pixel } from '../src/render/webgl/tests/fixture.js'
import { captureCanvas, captureLandmarks } from './ios-browser-capture-fixture.ts'

const originalBody = document.body.style.cssText
afterEach(() => {
  document.querySelector('#capture-control')?.remove()
  document.body.style.cssText = originalBody
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
})

async function checkCapture(left: number, top: number, scroll: number): Promise<void> {
  document.body.style.cssText = 'margin:0;min-height:2200px;background:white'
  const canvas = captureCanvas({ left, top })
  window.scrollTo({ top: scroll, left: 0, behavior: 'instant' })
  const source = await page.screenshot({ element: canvas, scale: 'device', save: false })
  const image = new Image()
  image.src = `data:image/png;base64,${source}`
  await image.decode()
  const rect = canvas.getBoundingClientRect()
  const ratio = devicePixelRatio
  const originX = Math.floor(rect.left + scrollX)
  const originY = Math.floor(rect.top + scrollY)
  expect([image.naturalWidth, image.naturalHeight]).toEqual([
    Math.round((Math.ceil(rect.right + scrollX) - originX) * ratio),
    Math.round((Math.ceil(rect.bottom + scrollY) - originY) * ratio),
  ])
  const decoded = document.createElement('canvas')
  decoded.width = image.naturalWidth
  decoded.height = image.naturalHeight
  const context = decoded.getContext('2d')!
  context.drawImage(image, 0, 0)
  const pixels = new Uint8Array(context.getImageData(0, 0, decoded.width, decoded.height).data)
  const dx = (rect.left + scrollX - originX) * ratio
  const dy = (rect.top + scrollY - originY) * ratio
  const samples = [
    { x: 1, y: 10, rgba: [255, 0, 0, 255] },
    { x: 10, y: 1, rgba: [0, 255, 0, 255] },
    { x: 41, y: 10, rgba: [0, 0, 255, 255] },
    { x: 10, y: 25, rgba: [255, 0, 255, 255] },
    { x: 13, y: 13, rgba: [49, 90, 155, 255] },
    { x: 29, y: 13, rgba: [128, 128, 128, 255] },
  ]
  for (const sample of samples)
    expect(
      pixel(
        pixels,
        decoded.width,
        Math.floor(dx + sample.x * ratio),
        Math.floor(dy + sample.y * ratio),
      ),
    ).toEqual(sample.rgba)
  if (left % 1 !== 0 || top % 1 !== 0)
    expect(pixel(pixels, decoded.width, 0, 0)).toEqual([255, 255, 255, 255])
  expect(rect.top).toBeGreaterThanOrEqual(0)
  expect(rect.bottom).toBeLessThanOrEqual(innerHeight)
}

describe('native enclosing capture controls', () => {
  test('captures fractional asymmetric edges and sRGB patches', async () => {
    await checkCapture(10.5, 10.5, 0)
  }, 15000)
  test('captures integer asymmetric edges and sRGB patches', async () => {
    await checkCapture(10, 10, 0)
  }, 15000)
  test('brings a fitting offscreen element into view', async () => {
    await checkCapture(10, 1400, 0)
  }, 15000)
  test('captures with a stable tester scroll position', async () => {
    await checkCapture(10, 110, 100)
    expect(scrollY).toBe(100)
  }, 15000)
  test('preserves the unchanged displayedPixels helper on asymmetric pixels', async () => {
    document.body.style.cssText = 'margin:0;min-height:2200px;background:white'
    const canvas = captureCanvas({ left: 10, top: 10 })
    const pixels = await displayedPixels(canvas)
    for (const { x, y, rgba } of captureLandmarks)
      expect(pixel(pixels, canvas.width, x, y)).toEqual(rgba)
  }, 15000)
})
