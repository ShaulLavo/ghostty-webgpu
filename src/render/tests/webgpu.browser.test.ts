import { expect, it } from 'vitest'
import { GlyphAtlas } from '../atlas/atlas.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import { AtlasGpuTextures } from '../atlas/gpu-textures.js'

const bytesPerRow = 256

async function createDevice(): Promise<GPUDevice> {
  expect(navigator.gpu).toBeDefined()
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  expect(adapter).not.toBeNull()
  if (!adapter) throw new Error('WebGPU requestAdapter returned null')
  return adapter.requestDevice()
}

async function readClearColor(device: GPUDevice): Promise<Uint8Array> {
  const texture = device.createTexture({
    format: 'rgba8unorm',
    size: [1, 1],
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const output = device.createBuffer({
    size: bytesPerRow,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        clearValue: { a: 1, b: 0.75, g: 0.5, r: 0.25 },
        loadOp: 'clear',
        storeOp: 'store',
        view: texture.createView(),
      },
    ],
  })
  pass.end()
  encoder.copyTextureToBuffer({ texture }, { buffer: output, bytesPerRow }, [1, 1])
  device.queue.submit([encoder.finish()])
  await output.mapAsync(GPUMapMode.READ)
  const pixels = Uint8Array.from(new Uint8Array(output.getMappedRange()).subarray(0, 4))
  output.unmap()
  output.destroy()
  texture.destroy()
  return pixels
}

it('creates a WebGPU device, submits a frame, and reads pixels back', async () => {
  const device = await createDevice()
  const pixels = await readClearColor(device)

  expect([...pixels]).toEqual([64, 128, 191, 255])
  device.destroy()
})

it('rasterizes and uploads grayscale and color atlas pages', async () => {
  const device = await createDevice()
  const atlas = new GlyphAtlas({ padding: 1, pageHeight: 128, pageWidth: 128 })
  const rasterizer = new CanvasGlyphRasterizer({
    cellHeight: 24,
    cellWidth: 16,
    fontFamily: 'monospace',
    fontSize: 18,
  })
  const values = ['A', 'e\u0301', '界', '🙂']
  const kinds = values.map((text, row) => {
    const bitmap = rasterizer.rasterize(text)
    atlas.getOrInsert(text, bitmap, row)
    return bitmap.kind
  })
  const textures = new AtlasGpuTextures()

  device.pushErrorScope('validation')
  textures.sync(device, atlas.consumeUploads())
  await device.queue.onSubmittedWorkDone()

  expect(kinds).toEqual(['grayscale', 'grayscale', 'grayscale', 'color'])
  expect(rasterizer.rasterize('A')).toBe(rasterizer.rasterize('A'))
  expect(textures.view('grayscale')).toBeDefined()
  expect(textures.view('color')).toBeDefined()
  expect(await device.popErrorScope()).toBeNull()
  textures.destroy()
  device.destroy()
})
