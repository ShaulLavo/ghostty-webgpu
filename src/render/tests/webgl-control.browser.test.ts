import { expect, test } from 'vitest'

test('creates and reads a WebGL2 context without the terminal renderer', () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  let creationError = ''
  canvas.addEventListener('webglcontextcreationerror', (event) => {
    if (event instanceof WebGLContextEvent) creationError = event.statusMessage
  })
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error(`Plain WebGL2 context creation failed: ${creationError}`)
  try {
    gl.clearColor(1, 0, 1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const pixel = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    expect(Array.from(pixel)).toEqual([255, 0, 255, 255])
    expect(gl.getError()).toBe(gl.NO_ERROR)
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
})
