import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StagingUploads } from './staging.js'

interface FakeBuffer {
  readonly id: number
  readonly bytes: ArrayBuffer
  mapped: boolean
  destroyed: boolean
  resolveMap?: () => void
  getMappedRange(): ArrayBuffer
  unmap(): void
  mapAsync(): Promise<void>
  destroy(): void
}

interface Copy {
  readonly source: number
  readonly sourceOffset: number
  readonly destination: string
  readonly destinationOffset: number
  readonly size: number
}

function fakeDevice() {
  const buffers: FakeBuffer[] = []
  const submits: Copy[][] = []
  const device = {
    createBuffer({ size, mappedAtCreation }: { size: number; mappedAtCreation?: boolean }) {
      const buffer: FakeBuffer = {
        id: buffers.length,
        bytes: new ArrayBuffer(size),
        mapped: mappedAtCreation === true,
        destroyed: false,
        getMappedRange() {
          if (!buffer.mapped) throw new Error('buffer is not mapped')
          return buffer.bytes
        },
        unmap() {
          buffer.mapped = false
        },
        mapAsync() {
          return new Promise<void>((resolve) => {
            buffer.resolveMap = () => {
              buffer.mapped = true
              resolve()
            }
          })
        },
        destroy() {
          buffer.destroyed = true
        },
      }
      buffers.push(buffer)
      return buffer
    },
    createCommandEncoder() {
      const copies: Copy[] = []
      return {
        copies,
        copyBufferToBuffer(
          source: FakeBuffer,
          sourceOffset: number,
          destination: { name: string },
          destinationOffset: number,
          size: number,
        ) {
          copies.push({
            source: source.id,
            sourceOffset,
            destination: destination.name,
            destinationOffset,
            size,
          })
        },
        finish: () => copies,
      }
    },
    queue: {
      submit(commands: Copy[][]) {
        submits.push(...commands)
      },
    },
  }
  return { device: device as unknown as GPUDevice, buffers, submits }
}

const cell = { name: 'cell' } as unknown as GPUBuffer
const glyph = { name: 'glyph' } as unknown as GPUBuffer
const globals = globalThis as Record<string, unknown>

function targets(cellData: Float32Array, glyphData: Float32Array) {
  return [
    { buffer: cell, data: cellData, mirrorOffset: 0, ranges: [{ byteOffset: 8, byteLength: 8 }] },
    {
      buffer: glyph,
      data: glyphData,
      mirrorOffset: 64,
      ranges: [{ byteOffset: 4, byteLength: 12 }],
    },
  ]
}

function encode(device: GPUDevice, staging: StagingUploads): Copy[] {
  const encoder = device.createCommandEncoder()
  staging.record(encoder)
  const copies = encoder.finish() as unknown as Copy[]
  staging.settleRecorded()
  return copies
}

beforeAll(() => {
  globals.GPUBufferUsage = { MAP_WRITE: 1, COPY_SRC: 4 }
  globals.GPUMapMode = { WRITE: 2 }
})

afterAll(() => {
  delete globals.GPUBufferUsage
  delete globals.GPUMapMode
})

describe('WebGPU staging uploads', () => {
  it('copies each range from its mirror offset to the same destination offset', () => {
    const { device, buffers } = fakeDevice()
    const staging = new StagingUploads(device, 128)
    const cellData = new Float32Array([0, 1, 2, 3, 4, 5])
    const glyphData = new Float32Array([10, 11, 12, 13, 14])
    expect(staging.stage(targets(cellData, glyphData))).toBe(true)
    expect(buffers[0]!.mapped).toBe(false)
    const bytes = new Float32Array(buffers[0]!.bytes)
    expect(Array.from(bytes.subarray(2, 4))).toEqual([2, 3])
    expect(Array.from(bytes.subarray(17, 20))).toEqual([11, 12, 13])
    expect(encode(device, staging)).toEqual([
      { source: 0, sourceOffset: 8, destination: 'cell', destinationOffset: 8, size: 8 },
      { source: 0, sourceOffset: 68, destination: 'glyph', destinationOffset: 4, size: 12 },
    ])
  })

  it('declines once every pooled buffer is in flight', () => {
    const { device, buffers } = fakeDevice()
    const staging = new StagingUploads(device, 128)
    const data = targets(new Float32Array(8), new Float32Array(8))
    expect(staging.stage(data)).toBe(true)
    encode(device, staging)
    staging.beginFrame()
    expect(staging.stage(data)).toBe(true)
    encode(device, staging)
    staging.beginFrame()
    expect(staging.stage(data)).toBe(false)
    expect(buffers).toHaveLength(2)
  })

  it('reuses a buffer once its write mapping resolves', async () => {
    const { device, buffers } = fakeDevice()
    const staging = new StagingUploads(device, 128)
    const data = targets(new Float32Array(8), new Float32Array(8))
    staging.stage(data)
    encode(device, staging)
    staging.beginFrame()
    buffers[0]!.resolveMap!()
    await Promise.resolve()
    expect(staging.stage(data)).toBe(true)
    expect(buffers).toHaveLength(1)
  })

  it('submits copies that missed their frame before the next frame writes', () => {
    const { device, submits, buffers } = fakeDevice()
    const staging = new StagingUploads(device, 128)
    staging.stage(targets(new Float32Array(8), new Float32Array(8)))
    staging.beginFrame()
    expect(submits).toHaveLength(1)
    expect(submits[0]).toHaveLength(2)
    expect(encode(device, staging)).toEqual([])
    expect(buffers[0]!.resolveMap).toBeDefined()
  })

  it('destroys pooled buffers', () => {
    const { device, buffers } = fakeDevice()
    const staging = new StagingUploads(device, 128)
    staging.stage(targets(new Float32Array(8), new Float32Array(8)))
    staging.destroy()
    expect(buffers.every((buffer) => buffer.destroyed)).toBe(true)
  })
})
