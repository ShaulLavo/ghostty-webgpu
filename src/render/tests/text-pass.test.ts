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
  const writes: {
    buffer: BufferState
    offset: number
    bytes: Uint8Array
    sourceBuffer: ArrayBufferLike
  }[] = []
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
        writes.push({
          buffer,
          offset,
          bytes,
          sourceBuffer: ArrayBuffer.isView(data) ? data.buffer : data,
        })
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

it('coalesces twelve full rows to two uploads with compact glyph bytes and preserved raw bits', () => {
  const fixture = gpuFixture(),
    data = frame()
  const updates = Array.from({ length: 12 }, (_, row) =>
    update(row, row * 2560, 2560, row * 3840, 3840),
  )
  expect(fixture.pass.uploadFrame(data, updates)).toBe(2)
  expect(fixture.writes.map((write) => write.bytes.byteLength)).toEqual([30720, 38400])
  expect(fixture.pass.metrics.uploadOperations).toBe(2)
  expect(fixture.pass.metrics.uploadedBytes).toBe(69120)
  expect(fixture.buffers[0]!.bytes).toEqual(
    new Uint8Array(data.cellData.buffer, data.cellData.byteOffset, data.cellData.byteLength),
  )
  const words = new Uint32Array(fixture.buffers[1]!.bytes.buffer)
  expect(words.slice(0, 20)).toEqual(
    Uint32Array.of(
      0x80000000,
      0x7fc12345,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      19,
      21,
      23,
    ),
  )
  expect(words.slice(20, 40)).toEqual(
    Uint32Array.of(25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 43, 45, 47),
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
    [160, 240],
  ])
  const words = new Uint32Array(fixture.buffers[1]!.bytes.buffer)
  expect(words.slice(60, 80)).toEqual(
    Uint32Array.of(73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 93, 95),
  )
})

it('bounding mode counts the actual uploaded span, including safe resident gaps', () => {
  const fixture = gpuFixture(),
    data = frame()
  expect(
    fixture.pass.uploadFrame(data, [update(0, 64, 64, 96, 96), update(3, 256, 64, 384, 96)]),
  ).toBe(2)
  expect(fixture.pass.frameUploadedBytes).toBe(576)
  expect(fixture.pass.metrics.uploadedBytes).toBe(576)
  expect(fixture.writes.map((write) => [write.offset, write.bytes.byteLength])).toEqual([
    [64, 256],
    [80, 320],
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
  expect(fixture.buffers[1]!.bytes.slice(0, 80)).toEqual(new Uint8Array(80))
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

it('maps the final native glyph slot into the final compact slot without an upload prefix', () => {
  const fixture = gpuFixture()
  const data = frame()
  fixture.pass.uploadFrame(data, [update(11, 0, 0, 479 * 96, 96)])
  expect(fixture.writes.map((write) => [write.offset, write.bytes.byteLength])).toEqual([
    [479 * 80, 80],
  ])
  const words = new Uint32Array(fixture.buffers[1]!.bytes.buffer)
  expect(words[479 * 20]).toBe(479 * 24 + 1)
  expect(words[479 * 20 + 19]).toBe(479 * 24 + 23)
  expect(fixture.buffers[1]!.bytes.slice(0, 479 * 80)).toEqual(new Uint8Array(479 * 80))
})

it('reuses its packing allocation while current native views refresh after real memory growth', () => {
  const fixture = gpuFixture()
  const memory = new WebAssembly.Memory({ initial: 2 })
  const source = {
    get cellData() {
      return new Float32Array(memory.buffer, 16, 480 * 16)
    },
    get glyphData() {
      return new Float32Array(memory.buffer, 30816, 480 * 24)
    },
  }
  fixture.pass.uploadFrame(source, [update(0, 0, 0, 0, 96)])
  const packingBuffer = fixture.writes[0]!.sourceBuffer
  const oldNative = source.glyphData
  memory.grow(1)
  expect(oldNative.byteLength).toBe(0)
  const words = new Uint32Array(memory.buffer, 30816, 480 * 24)
  words[479 * 24] = 0x7fc54321
  words[479 * 24 + 22] = 0x80000000
  fixture.pass.uploadFrame(source, [update(11, 0, 0, 479 * 96, 96)])
  expect(fixture.writes[1]!.sourceBuffer).toBe(packingBuffer)
  const packed = new Uint32Array(fixture.writes[1]!.bytes.buffer)
  expect(packed[0]).toBe(0x7fc54321)
  expect(packed[19]).toBe(0x80000000)
})
