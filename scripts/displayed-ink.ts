import type { Page } from 'playwright'

export async function displayedInk(page: Page): Promise<{ red: number; green: number }> {
  const png = await page.locator('main canvas').screenshot()
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Screenshot decoding requires Canvas2D')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let red = 0
    let green = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const r = pixels[offset] ?? 0
      const g = pixels[offset + 1] ?? 0
      const b = pixels[offset + 2] ?? 0
      if (r > 150 && g < 80 && b < 80) red += 1
      if (g > 150 && r < 80 && b < 80) green += 1
    }
    return { red, green }
  }, png.toString('base64'))
}
