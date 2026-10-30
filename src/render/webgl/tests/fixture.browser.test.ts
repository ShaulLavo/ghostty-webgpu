import { expect, it } from 'vitest'
import { displayedPixels, pixel } from './fixture.js'

it('maps a fractional padded screenshot into the canvas backing-pixel grid', async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 48
  canvas.style.cssText =
    'position:absolute;left:10.5px;top:10.5px;width:32px;height:16px;padding:2px;border:3px solid lime;box-sizing:content-box;'
  document.body.append(canvas)
  try {
    const context = canvas.getContext('2d')!
    context.fillStyle = 'red'
    context.fillRect(0, 0, 48, 48)
    context.fillStyle = 'blue'
    context.fillRect(48, 0, 48, 48)
    const pixels = await displayedPixels(canvas)
    expect(pixels.byteLength).toBe(96 * 48 * 4)
    expect(pixel(pixels, 96, 12, 24)).toEqual([255, 0, 0, 255])
    expect(pixel(pixels, 96, 84, 24)).toEqual([0, 0, 255, 255])
  } finally {
    canvas.remove()
  }
})
