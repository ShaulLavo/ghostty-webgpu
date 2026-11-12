import { PNG } from 'pngjs/browser.js'

export async function decodePngFixture(bytes: Uint8Array): Promise<{
  width: number
  height: number
  data: Uint8ClampedArray<ArrayBuffer>
}> {
  // Decode fixture bytes directly: Safari can add fingerprinting noise to Canvas readback.
  return new Promise((resolve, reject) => {
    new PNG().parse(bytes, (error, image) => {
      if (error) return reject(error)
      if (!image) return reject(new Error('PNG fixture has no decoded image'))
      resolve({ width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) })
    })
  })
}
