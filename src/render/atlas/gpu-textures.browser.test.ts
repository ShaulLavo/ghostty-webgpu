import { expect, it } from 'vitest'
import { AtlasGpuTextures } from './gpu-textures.js'
import type { AtlasKind, AtlasPageUpload, AtlasTextureLayout } from './types.js'

const layout: AtlasTextureLayout = { layerCount: 2, pageHeight: 5, pageWidth: 7 }

async function createDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU requestAdapter returned null')
  return adapter.requestDevice()
}

function upload(kind: AtlasKind, layer: number, marker: number): AtlasPageUpload {
  const pixelBytes = kind === 'grayscale' ? 1 : 4
  const pixels = new Uint8Array(layout.pageWidth * layout.pageHeight * pixelBytes)
  for (let y = 1; y < 3; y += 1) {
    for (let x = 2; x < 5; x += 1) {
      const offset = (y * layout.pageWidth + x) * pixelBytes
      if (kind === 'grayscale') {
        pixels[offset] = marker
        continue
      }
      pixels.set([marker, 255 - marker, layer * 80, 255], offset)
    }
  }
  return {
    bytesPerRow: layout.pageWidth * pixelBytes,
    dataOffset: (layout.pageWidth + 2) * pixelBytes,
    extent: { height: 2, width: 3 },
    kind,
    layer,
    origin: { x: 2, y: 1 },
    pixels,
  }
}

async function readPixel(
  device: GPUDevice,
  textures: AtlasGpuTextures,
  kind: AtlasKind,
  layer: number,
): Promise<readonly number[]> {
  const buffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer(
    { origin: { x: 2, y: 1, z: layer }, texture: textures.texture(kind) },
    { buffer, bytesPerRow: 256 },
    { depthOrArrayLayers: 1, height: 1, width: 1 },
  )
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const length = kind === 'grayscale' ? 1 : 4
  const result = [...new Uint8Array(buffer.getMappedRange()).subarray(0, length)]
  buffer.unmap()
  buffer.destroy()
  return result
}

it('uploads odd-stride dirty rectangles to two layers of each fixed texture array', async () => {
  const device = await createDevice()
  device.pushErrorScope('validation')
  const textures = new AtlasGpuTextures(device, layout)
  const grayscaleView = textures.view('grayscale')
  const colorView = textures.view('color')

  textures.sync([
    upload('grayscale', 0, 64),
    upload('grayscale', 1, 192),
    upload('color', 0, 32),
    upload('color', 1, 224),
  ])
  await device.queue.onSubmittedWorkDone()

  expect(await readPixel(device, textures, 'grayscale', 0)).toEqual([64])
  expect(await readPixel(device, textures, 'grayscale', 1)).toEqual([192])
  expect(await readPixel(device, textures, 'color', 0)).toEqual([32, 223, 0, 255])
  expect(await readPixel(device, textures, 'color', 1)).toEqual([224, 31, 80, 255])
  expect(textures.uploadBytes).toBe(60)
  expect(textures.uploadOperationCount).toBe(4)
  expect(textures.textureCreationCount).toBe(2)
  expect(textures.view('grayscale')).toBe(grayscaleView)
  expect(textures.view('color')).toBe(colorView)
  expect(await device.popErrorScope()).toBeNull()
  textures.destroy()
  device.destroy()
})

it('rejects a layer capacity above the adapter limit before allocating textures', async () => {
  const device = await createDevice()
  const oversized = { ...layout, layerCount: device.limits.maxTextureArrayLayers + 1 }

  expect(() => new AtlasGpuTextures(device, oversized)).toThrow(/exceeds adapter limit/u)
  device.destroy()
})
