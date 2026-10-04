import { afterEach, expect, it, vi } from 'vitest'
import { WebGpuTextPass } from '../text-pass.js'
import type { RowInstanceUpdate } from '../instances/types.js'

interface BufferState {
  bytes: Uint8Array
  destroy(): void
}

function gpuFixture() {
  vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, STORAGE: 128, UNIFORM: 64 })
  const buffers: BufferState[] = []
  const writes: { buffer: BufferState; offset: number; bytes: Uint8Array }[] = []
  const pipeline = { getBindGroupLayout: () => ({}) }
  const device = {
    createBuffer({ size }: { size: number }) {
      const buffer = { bytes: new Uint8Array(size), destroy() {} }
      buffers.push(buffer)
      return buffer
    },
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => pipeline,
    createBindGroup: () => ({}),
    queue: {
      writeBuffer(
        buffer: BufferState,
        offset: number,
        data: ArrayBuffer | ArrayBufferView,
        sourceOffset = 0,
        size?: number,
      ) {
        const source = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data)
        const bytes = source.slice(sourceOffset, sourceOffset + (size ?? source.byteLength))
        buffer.bytes.set(bytes, offset)
        writes.push({ buffer, offset, bytes })
      },
    },
  } as unknown as GPUDevice
  const pass = new WebGpuTextPass({
    device,
    format: 'rgba8unorm',
    height: 12,
    width: 40,
    instanceCount: 480,
  })
  writes.length = 0
  return { pass, buffers, writes }
}

function frame() {
  const cellData = new Float32Array(new ArrayBuffer(480 * 64 + 32), 16, 480 * 16)
  const glyphData = new Float32Array(new ArrayBuffer(480 * 96 + 32), 16, 480 * 24)
  for (const data of [cellData, glyphData]) {
    const words = new Uint32Array(data.buffer, data.byteOffset, data.length)
    for (let index = 0; index < words.length; index++) words[index] = index + 1
    words[0] = 0x80000000
    words[1] = 0x7fc12345
  }
  return { cellData, glyphData }
}

const empty = { byteOffset: 0, byteLength: 0 }
function update(
  row: number,
  cellOffset: number,
  cellLength: number,
  glyphOffset = 0,
  glyphLength = 0,
): RowInstanceUpdate {
  return {
    row,
    cell: { byteOffset: cellOffset, byteLength: cellLength },
    glyph: { byteOffset: glyphOffset, byteLength: glyphLength },
  }
}

afterEach(() => vi.unstubAllGlobals())

it('coalesces twelve full rows to two uploads with unchanged bytes, including signed zero and NaN payloads', () => {
  const fixture = gpuFixture(),
    data = frame()
  const updates = Array.from({ length: 12 }, (_, row) =>
    update(row, row * 2560, 2560, row * 3840, 3840),
  )
  expect(fixture.pass.uploadFrame(data, updates)).toBe(2)
  expect(fixture.writes.map((write) => write.bytes.byteLength)).toEqual([30720, 46080])
  expect(fixture.pass.metrics.uploadOperations).toBe(2)
  expect(fixture.pass.metrics.uploadedBytes).toBe(76800)
  expect(fixture.buffers[0]!.bytes).toEqual(
    new Uint8Array(data.cellData.buffer, data.cellData.byteOffset, data.cellData.byteLength),
  )
  expect(fixture.buffers[1]!.bytes).toEqual(
    new Uint8Array(data.glyphData.buffer, data.glyphData.byteOffset, data.glyphData.byteLength),
  )
})

it('bounds unordered cell and glyph changes independently using resident gap bytes', () => {
  const fixture = gpuFixture(),
    data = frame()
  expect(
    fixture.pass.uploadFrame(data, [
      update(2, 128, 64, 192, 96),
      update(0, 0, 64),
      update(1, 64, 64, 384, 96),
    ]),
  ).toBe(2)
  expect(fixture.writes.map((write) => [write.offset, write.bytes.byteLength])).toEqual([
    [0, 192],
    [192, 288],
  ])
  expect(fixture.buffers[1]!.bytes.slice(192, 480)).toEqual(
    new Uint8Array(data.glyphData.buffer, data.glyphData.byteOffset + 192, 288),
  )
})

it('bounding mode counts the actual uploaded span, including safe resident gaps', () => {
  const fixture = gpuFixture(),
    data = frame()
  expect(
    fixture.pass.uploadFrame(data, [update(0, 64, 64, 96, 96), update(3, 256, 64, 384, 96)]),
  ).toBe(2)
  expect(fixture.pass.frameUploadedBytes).toBe(640)
  expect(fixture.pass.metrics.uploadedBytes).toBe(640)
  expect(fixture.writes.map((write) => [write.offset, write.bytes.byteLength])).toEqual([
    [64, 256],
    [96, 384],
  ])
})

it('reads each frame view once even when several rows change', () => {
  const fixture = gpuFixture(),
    data = frame()
  const cellRead = vi.fn(() => data.cellData)
  const glyphRead = vi.fn(() => data.glyphData)
  const source = {
    get cellData() {
      return cellRead()
    },
    get glyphData() {
      return glyphRead()
    },
  }
  fixture.pass.uploadFrame(source, [update(0, 0, 64, 0, 96), update(1, 64, 64, 96, 96)])
  expect(cellRead).toHaveBeenCalledTimes(1)
  expect(glyphRead).toHaveBeenCalledTimes(1)
})

it('retains glyph erasure bytes and reads fresh views after memory replacement', () => {
  const fixture = gpuFixture(),
    data = frame()
  fixture.pass.uploadFrame(data, [update(0, 0, 64, 0, 96)])
  const replacement = frame()
  replacement.glyphData.fill(0)
  fixture.writes.length = 0
  fixture.pass.uploadFrame(replacement, [
    { row: 0, cell: empty, glyph: { byteOffset: 0, byteLength: 96 } },
  ])
  expect(fixture.writes).toHaveLength(1)
  expect(fixture.buffers[1]!.bytes.slice(0, 96)).toEqual(new Uint8Array(96))
})

it('unchanged frames produce no uploads and reset per-frame bytes without resetting cumulative metrics', () => {
  const fixture = gpuFixture(),
    data = frame()
  fixture.pass.uploadFrame(data, [update(0, 0, 64)])
  fixture.writes.length = 0
  expect(fixture.pass.uploadFrame(data, [])).toBe(0)
  expect(fixture.pass.frameUploadedBytes).toBe(0)
  expect(fixture.pass.metrics.uploadedBytes).toBe(64)
  expect(fixture.writes).toEqual([])
})
