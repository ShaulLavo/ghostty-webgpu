import { expect } from 'vitest'
import { displayedPixels } from '../../render/webgl/tests/fixture.js'

export async function webglScreenshotSkipReason(): Promise<string | undefined> {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  canvas.style.cssText = 'display:block;background:rgb(17,17,17)'
  document.body.append(canvas)
  const gl = canvas.getContext('webgl2', { antialias: false })
  try {
    if (!gl) return 'WebGL2 is unavailable in this browser'
    gl.clearColor(1, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.flush()
    const expected = new Uint8Array(canvas.width * canvas.height * 4)
    for (let i = 0; i < expected.length; i += 4) expected.set([255, 0, 0, 255], i)
    const framebuffer = new Uint8Array(expected.length)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, framebuffer)
    expect(gl.getError(), 'Standalone WebGL2 control has no GL error').toBe(gl.NO_ERROR)
    expect(framebuffer, 'Standalone WebGL2 framebuffer is red').toEqual(expected)
    const screenshot = await displayedPixels(canvas)
    const backgroundOnly = screenshot.every((value, i) => value === (i % 4 === 3 ? 255 : 17))
    if (backgroundOnly)
      return 'Browser screenshots omit WebGL2 pixels despite a readable red framebuffer (headless Linux WebKit)'
    expect(screenshot, 'Standalone WebGL2 pixels reach browser screenshots').toEqual(expected)
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    canvas.remove()
  }
}

export async function workerWebglSkipReason(): Promise<string | undefined> {
  if (
    typeof OffscreenCanvas === 'undefined' ||
    !HTMLCanvasElement.prototype.transferControlToOffscreen
  )
    return 'This browser cannot transfer a canvas to a worker'
  const worker = new Worker(new URL('./webgl-capability.worker.ts', import.meta.url), {
    type: 'module',
  })
  const supported = Promise.withResolvers<unknown>()
  const timeout = setTimeout(
    () => supported.reject(new Error('Worker WebGL2 probe did not reply')),
    5_000,
  )
  try {
    worker.onmessage = (event: MessageEvent<unknown>) => supported.resolve(event.data)
    worker.onerror = (event) => supported.reject(new Error(event.message))
    const canvas = document.createElement('canvas').transferControlToOffscreen()
    worker.postMessage(canvas, [canvas])
    const result = await supported.promise
    expect(typeof result, 'Standalone worker returns a WebGL2 capability result').toBe('boolean')
    if (result === false)
      return 'WebGL2 is unavailable on a transferred OffscreenCanvas in this browser worker'
  } finally {
    clearTimeout(timeout)
    worker.terminate()
  }
}
