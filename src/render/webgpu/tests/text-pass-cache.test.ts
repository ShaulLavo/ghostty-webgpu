import { describe, expect, it, vi } from 'vitest'
import { glyphKey } from '../../shared/atlas/key.js'
import { WebGpuTextPass } from '../text-pass.js'

const gpuBufferUsage = {
  COPY_DST: 8,
  COPY_SRC: 4,
  MAP_WRITE: 2,
  STORAGE: 128,
  UNIFORM: 64,
}

function fakeDevice() {
  const device = {
    createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
    createBuffer: vi.fn(
      () =>
        ({
          destroy: vi.fn(),
          getMappedRange: vi.fn(() => new ArrayBuffer(0)),
          mapAsync: vi.fn(() => Promise.resolve()),
          unmap: vi.fn(),
        }) as unknown as GPUBuffer,
    ),
    createRenderPipeline: vi.fn(
      () =>
        ({
          getBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
        }) as unknown as GPURenderPipeline,
    ),
    createSampler: vi.fn(() => ({}) as GPUSampler),
    createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
    limits: {
      maxBufferSize: 256 * 1024 * 1024,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
    },
    queue: { writeBuffer: vi.fn() },
  }
  return device as unknown as GPUDevice & typeof device
}

describe('WebGpuTextPass pipeline caching', () => {
  it('compiles shaders once per device, format, and textBlink mode across resizes', () => {
    const previous = globalThis.GPUBufferUsage
    Object.defineProperty(globalThis, 'GPUBufferUsage', {
      configurable: true,
      value: gpuBufferUsage,
    })
    try {
      const device = fakeDevice()
      const first = new WebGpuTextPass({
        device,
        format: 'bgra8unorm',
        height: 400,
        instanceCount: 800,
        width: 800,
      })
      const second = new WebGpuTextPass({
        device,
        format: 'bgra8unorm',
        height: 500,
        instanceCount: 1200,
        width: 1000,
      })
      expect(device.createShaderModule).toHaveBeenCalledTimes(2)
      expect(device.createRenderPipeline).toHaveBeenCalledTimes(2)
      expect(device.createSampler).toHaveBeenCalledTimes(1)

      const blinking = new WebGpuTextPass({
        device,
        format: 'bgra8unorm',
        height: 500,
        instanceCount: 1200,
        textBlink: true,
        width: 1000,
      })
      expect(device.createShaderModule).toHaveBeenCalledTimes(4)
      expect(device.createRenderPipeline).toHaveBeenCalledTimes(4)
      expect(device.createSampler).toHaveBeenCalledTimes(2)

      first.destroy()
      second.destroy()
      blinking.destroy()
    } finally {
      Object.defineProperty(globalThis, 'GPUBufferUsage', {
        configurable: true,
        value: previous,
      })
    }
  })
})

describe('glyphKey injectivity', () => {
  it('keeps distinct inputs unambiguous even with delimiters or null bytes in text', () => {
    const base = {
      cellSpan: 1,
      foreground: { r: 10, g: 20, b: 30 },
      italic: false,
      text: 'A',
      weight: 'normal' as const,
    }
    const keys = new Set([
      glyphKey(base, 'grayscale'),
      glyphKey({ ...base, cellSpan: 2 }, 'grayscale'),
      glyphKey({ ...base, constraintWidth: 2 }, 'grayscale'),
      glyphKey({ ...base, italic: true }, 'grayscale'),
      glyphKey({ ...base, weight: 'bold' }, 'grayscale'),
      glyphKey({ ...base, text: 'A\0B' }, 'grayscale'),
      glyphKey({ ...base, text: ':10,20,30\0A' }, 'grayscale'),
      glyphKey(base, 'color'),
      glyphKey({ ...base, foreground: { r: 10, g: 20, b: 31 } }, 'color'),
      glyphKey({ ...base, text: '["A",1]' }, 'color'),
    ])
    expect(keys.size).toBe(10)
    expect(glyphKey(base, 'grayscale')).toBe(
      glyphKey({ ...base, foreground: { r: 255, g: 0, b: 0 } }, 'grayscale'),
    )
  })
})
