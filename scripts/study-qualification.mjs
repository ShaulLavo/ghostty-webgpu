import assert from 'node:assert/strict'

export function studyCanvases(info, variant, count) {
  const contexts = {
    'ghostty-webgpu': 'webgpu',
    'ghostty-webgl': 'webgl2',
    'xterm-webgl': 'webgl2',
    'nm-webgpu': 'webgpu',
  }
  const active =
    variant === 'wraith-native'
      ? info.canvases
      : info.canvases.filter((canvas) => canvas.context === contexts[variant])
  assert.equal(active.length, count, `Expected ${count} active ${variant} canvases`)
  for (const canvas of active) {
    const expected = { width: 700 * info.dpr, height: 570 * info.dpr }
    assert(
      canvas.width === expected.width && canvas.height === expected.height,
      `Active ${variant} backing ${canvas.width}x${canvas.height}, expected ${expected.width}x${expected.height}`,
    )
    assert.equal(canvas.bounds.width, 700)
    assert.equal(canvas.bounds.height, 570)
  }
  return active
}

export function qualifyStudyPaint(pixels) {
  let matchingPixels = 0
  const pixelCount = pixels.length / 4
  for (let index = 0; index < pixels.length; index += 4) {
    const delta = Math.max(
      Math.abs(pixels[index] - 25),
      Math.abs(pixels[index + 1] - 100),
      Math.abs(pixels[index + 2] - 200),
    )
    matchingPixels += Number(delta <= 2)
  }
  assert(
    pixelCount > 0 && matchingPixels / pixelCount >= 0.999,
    `Paint qualification failed: ${matchingPixels}/${pixelCount} expected-color pixels`,
  )
  return { matchingPixels, pixelCount }
}
