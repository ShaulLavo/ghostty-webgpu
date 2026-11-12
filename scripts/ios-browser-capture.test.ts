import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { test } from 'vitest'
import { isEnclosingDeviceCapture } from './ios-browser-capture.ts'
import { planEnclosingCrop, type CaptureGeometry } from './ios-browser-capture-geometry.ts'
import { cropPngLossless, inspectCapturePng, pngCrc } from './ios-browser-capture-png.ts'

function geometry(): CaptureGeometry {
  return {
    element: { left: 10.5, top: 10.5, right: 52.5, bottom: 36.5 },
    tester: {
      scrollX: 0,
      scrollY: 100,
      width: 300,
      height: 600,
      dpr: 3,
      visual: { offsetLeft: 0, offsetTop: 0, scale: 1 },
    },
    frame: { left: 20, top: 30, width: 300, height: 600, cornersHitFrame: true },
    top: {
      scrollX: 15,
      scrollY: 70,
      dpr: 3,
      visual: { offsetLeft: 2, offsetTop: 4, width: 414, height: 896, scale: 1 },
    },
  }
}
const viewport = { width: 1242, height: 2688 }

test('encloses the original fractional box with frame offsets, top and tester scroll', () => {
  assert.deepEqual(planEnclosingCrop(geometry(), viewport), {
    x: 84,
    y: 108,
    width: 129,
    height: 81,
  })
  const value = geometry()
  value.element = { left: 10, top: 10, right: 52, bottom: 36 }
  assert.deepEqual(planEnclosingCrop(value, viewport), { x: 84, y: 108, width: 126, height: 78 })
})

const rejections: [string, (value: CaptureGeometry) => void][] = [
  [
    'pinch zoom',
    (g) => {
      g.top.visual.scale = 1.25
    },
  ],
  [
    'frame scale',
    (g) => {
      g.frame.width *= 0.5
    },
  ],
  [
    'DPR mismatch',
    (g) => {
      g.tester.dpr = 2
    },
  ],
  [
    'fractional scroll',
    (g) => {
      g.tester.scrollX = 0.2
    },
  ],
  [
    'tester containment',
    (g) => {
      g.element.right = 301
    },
  ],
  [
    'top containment',
    (g) => {
      g.frame.left = 400
    },
  ],
  [
    'tester visual offset',
    (g) => {
      g.tester.visual.offsetLeft = 1
    },
  ],
  [
    'obstruction',
    (g) => {
      g.frame.cornersHitFrame = false
    },
  ],
  [
    'empty box',
    (g) => {
      g.element.right = g.element.left = 10
    },
  ],
  [
    'NaN',
    (g) => {
      g.element.left = NaN
    },
  ],
  [
    'infinite DPR',
    (g) => {
      g.top.dpr = g.tester.dpr = Infinity
    },
  ],
  [
    'zero dimension',
    (g) => {
      g.top.visual.height = 0
    },
  ],
]
test.each(rejections)('rejects unsupported geometry: %s', (_name, mutate) => {
  const value = geometry()
  mutate(value)
  assert.throws(() => planEnclosingCrop(value, viewport))
})

test('rejects a same-route viewport PNG with an inset or wrong scale', () => {
  assert.throws(
    () => planEnclosingCrop(geometry(), { width: 1242, height: 2691 }),
    /does not match/,
  )
  assert.throws(() => planEnclosingCrop(geometry(), { width: 414, height: 896 }), /does not match/)
})

test('dispatch is restricted to element, no target, device and save false', () => {
  const options = {
    element: { selector: '#canvas', locator: null },
    scale: 'device',
    save: false,
  } satisfies import('./ios-browser.ts').ProviderScreenshotOptions
  assert.equal(isEnclosingDeviceCapture(options), true)
  assert.equal(isEnclosingDeviceCapture({ ...options, save: true }), false)
  assert.equal(isEnclosingDeviceCapture({ ...options, save: undefined }), false)
  assert.equal(isEnclosingDeviceCapture({ ...options, element: undefined }), false)
  assert.equal(isEnclosingDeviceCapture({ ...options, target: 'page' }), false)
  assert.equal(isEnclosingDeviceCapture({ ...options, scale: 'css' }), false)
  assert.equal(isEnclosingDeviceCapture({ ...options, scale: undefined }), false)
})

function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(type, 4, 'ascii')
  data.copy(bytes, 8)
  bytes.writeUInt32BE(pngCrc(bytes.subarray(4, -4)), bytes.length - 4)
  return bytes
}

function sourcePng(): Buffer {
  const png = new PNG({ width: 9, height: 7 })
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 31) % 256
  return PNG.sync.write(png)
}

test('lossless PNG crop preserves RGBA samples and exact ordered color chunks', () => {
  const source = sourcePng()
  const profiles = [
    chunk('gAMA', Buffer.from([0, 0, 177, 143])),
    chunk('sRGB', Buffer.from([0])),
    chunk('cICP', Buffer.from([1, 13, 0, 1])),
  ]
  const input = Buffer.concat([source.subarray(0, 33)].concat(profiles, [source.subarray(33)]))
  const output = cropPngLossless(input, { x: 2, y: 3, width: 4, height: 2 })
  assert.deepEqual(inspectCapturePng(output).profiles, ['gAMA', 'sRGB', 'cICP'])
  assert.deepEqual(
    inspectCapturePng(output)
      .chunks.filter((c) => c.type !== 'IHDR' && c.type !== 'IDAT' && c.type !== 'IEND')
      .map((c) => c.bytes),
    profiles,
  )
  const decoded = PNG.sync.read(input)
  const expected = Buffer.concat([
    decoded.data.subarray((3 * 9 + 2) * 4, (3 * 9 + 6) * 4),
    decoded.data.subarray((4 * 9 + 2) * 4, (4 * 9 + 6) * 4),
  ])
  assert.deepEqual(PNG.sync.read(output).data, expected)
})

test('accepts opaque RGB and preserves its exact sample bytes', () => {
  const png = new PNG({ width: 4, height: 3 })
  png.data.fill(255)
  const source = PNG.sync.write(png, { colorType: 2 })
  const output = cropPngLossless(source, { x: 1, y: 1, width: 2, height: 1 })
  assert.equal(inspectCapturePng(output).colorType, 2)
  assert.deepEqual(PNG.sync.read(output).data, Buffer.alloc(8, 255))
  const transparent = Buffer.concat([
    source.subarray(0, 33),
    chunk('tRNS', Buffer.alloc(6)),
    source.subarray(33),
  ])
  assert.throws(
    () => cropPngLossless(transparent, { x: 0, y: 0, width: 1, height: 1 }),
    /Transparent RGB/,
  )
})

test('rejects unsupported formats, dimensions, invalid chunks and invalid crops before allocation', () => {
  const source = sourcePng()
  const formats: [number, number][] = [
    [16, 6],
    [8, 3],
    [8, 0],
    [8, 4],
  ]
  for (const [depth, color] of formats) {
    const changed = Buffer.from(source)
    changed[24] = depth
    changed[25] = color
    changed.writeUInt32BE(pngCrc(changed.subarray(12, 29)), 29)
    assert.throws(() => inspectCapturePng(changed), /8-bit RGB/)
  }
  const huge = Buffer.from(source)
  huge.writeUInt32BE(0x7fffffff, 16)
  huge.writeUInt32BE(pngCrc(huge.subarray(12, 29)), 29)
  assert.throws(() => inspectCapturePng(huge), /dimensions/)
  const corrupt = chunk('iCCP', Buffer.from('synthetic profile CRC test'))
  corrupt[8] = corrupt[8]! ^ 1
  assert.throws(
    () => inspectCapturePng(Buffer.concat([source.subarray(0, 33), corrupt, source.subarray(33)])),
    /CRC/,
  )
  assert.throws(() => inspectCapturePng(source.subarray(0, -1)), /chunk/)
  assert.throws(() => cropPngLossless(source, { x: 8, y: 6, width: 2, height: 1 }), /bounds/)
})
