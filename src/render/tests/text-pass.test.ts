import { afterEach, expect, it, vi } from 'vitest'
import { WebGpuTextPass } from '../text-pass.js'
import { AtlasGpuTextures } from '../atlas/gpu-textures.js'
import type { RowInstanceUpdate } from '../instances/types.js'

interface BufferState {
  bytes: Uint8Array
  destroy(): void
}

function gpuFixture(
  instanceCount = 480,
  limits = { maxStorageBufferBindingSize: 134217728, maxBufferSize: 268435456 },
) {
  vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, STORAGE: 128, UNIFORM: 64 })
  vi.stubGlobal('GPUTextureUsage', { COPY_DST: 8, COPY_SRC: 4, TEXTURE_BINDING: 16 })
  const buffers: BufferState[] = []
  const writes: {
    buffer: BufferState
    offset: number
    bytes: Uint8Array
    sourceBuffer: ArrayBufferLike
  }[] = []
  const bindGroups: GPUBindGroupDescriptor[] = []
  const draws: number[] = []
  const renderPass = {
    setPipeline() {},
    setBindGroup() {},
    draw(_vertices: number, instances: number) {
      draws.push(instances)
    },
    end() {},
  }
  const pipeline = { getBindGroupLayout: () => ({}) }
  const device = {
    limits: { ...limits, maxTextureArrayLayers: 256 },
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createCommandEncoder: () => ({ beginRenderPass: () => renderPass, finish: () => ({}) }),
    createBuffer({ size }: { size: number }) {
      const buffer = { bytes: new Uint8Array(size), destroy() {} }
      buffers.push(buffer)
      return buffer
    },
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => pipeline,
    createBindGroup(descriptor: GPUBindGroupDescriptor) {
      bindGroups.push(descriptor)
      return {}
    },
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
    instanceCount,
  })
  writes.length = 0
  return { device, pass, buffers, writes, bindGroups, draws }
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

it.each([
  { maxStorageBufferBindingSize: 256, maxBufferSize: 268435456 },
  { maxStorageBufferBindingSize: 134217728, maxBufferSize: 256 },
])(
  'splits native glyphs at either device limit: $maxStorageBufferBindingSize/$maxBufferSize',
  (limits) => {
    const fixture = gpuFixture(4, limits)
    const data = frame()
    const textures = new AtlasGpuTextures(fixture.device, {
      layerCount: 1,
      pageHeight: 8,
      pageWidth: 8,
    })
    fixture.pass.syncAtlas(textures)
    expect(fixture.buffers.map((buffer) => buffer.bytes.byteLength)).toEqual([256, 192, 192, 16])
    expect(fixture.pass.glyphBindGroupCreationCount).toBe(2)
    expect(fixture.pass.uploadFrame(data, [update(0, 0, 256, 0, 384)])).toBe(3)
    expect(fixture.pass.frameUploadedBytes).toBe(640)
    expect(
      fixture.writes.slice(1).map((write) => write.sourceBuffer === data.glyphData.buffer),
    ).toEqual([true, true])
    expect(fixture.buffers[1]!.bytes).toEqual(
      new Uint8Array(data.glyphData.buffer, data.glyphData.byteOffset, 192),
    )
    expect(fixture.buffers[2]!.bytes).toEqual(
      new Uint8Array(data.glyphData.buffer, data.glyphData.byteOffset + 192, 192),
    )
    fixture.pass.encode({} as GPUTextureView)
    fixture.pass.acceptFrame()
    expect(fixture.draws).toEqual([4, 2, 2])
    expect(fixture.pass.metrics.draws).toBe(3)

    fixture.writes.length = 0
    data.glyphData.fill(0, 72, 96)
    expect(fixture.pass.uploadFrame(data, [update(0, 0, 0, 288, 96)])).toBe(1)
    expect(fixture.writes[0]!.buffer).toBe(fixture.buffers[2])
    expect(fixture.writes[0]!.offset).toBe(96)
    expect(fixture.writes[0]!.bytes).toEqual(new Uint8Array(96))
    expect(fixture.pass.frameUploadedBytes).toBe(96)
    expect(fixture.pass.uploadFrame(data, [])).toBe(0)
  },
)

it.each([
  { maxStorageBufferBindingSize: 255, maxBufferSize: 268435456 },
  { maxStorageBufferBindingSize: 134217728, maxBufferSize: 255 },
])(
  'rejects an unsupported cell allocation before creating any buffers: $maxStorageBufferBindingSize/$maxBufferSize',
  (limits) => {
    const fixture = gpuFixture(1)
    const created = fixture.buffers.length
    Object.assign(fixture.device.limits, limits)
    expect(
      () =>
        new WebGpuTextPass({
          device: fixture.device,
          format: 'rgba8unorm',
          height: 1,
          width: 1,
          instanceCount: 4,
        }),
    ).toThrow('The grid needs 256 cell-storage bytes')
    expect(fixture.buffers).toHaveLength(created)
  },
)

it('uploads native glyph records from their current backing view without repacking', () => {
  const fixture = gpuFixture()
  const data = frame()
  fixture.pass.uploadFrame(data, [update(0, 0, 0, 192, 96)])
  expect(fixture.writes[0]!.sourceBuffer === data.glyphData.buffer).toBe(true)
  expect(fixture.writes[0]!.offset).toBe(192)
  expect(fixture.writes[0]!.bytes).toEqual(
    new Uint8Array(data.glyphData.buffer, data.glyphData.byteOffset + 192, 96),
  )
})

it('coalesces twelve full rows to two uploads with native glyph bytes and preserved raw bits', () => {
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
  const words = new Uint32Array(fixture.buffers[1]!.bytes.buffer)
  expect(words.slice(72, 96)).toEqual(
    new Uint32Array(data.glyphData.buffer, data.glyphData.byteOffset + 288, 24),
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

it('uploads the final native glyph slot without an upload prefix', () => {
  const fixture = gpuFixture()
  const data = frame()
  fixture.pass.uploadFrame(data, [update(11, 0, 0, 479 * 96, 96)])
  expect(fixture.writes.map((write) => [write.offset, write.bytes.byteLength])).toEqual([
    [479 * 96, 96],
  ])
  const words = new Uint32Array(fixture.buffers[1]!.bytes.buffer)
  expect(words[479 * 24]).toBe(479 * 24 + 1)
  expect(words[479 * 24 + 22]).toBe(479 * 24 + 23)
  expect(fixture.buffers[1]!.bytes.slice(0, 479 * 96)).toEqual(new Uint8Array(479 * 96))
})

it('refreshes the direct native upload view after real memory growth', () => {
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
  const originalBuffer = fixture.writes[0]!.sourceBuffer
  const oldNative = source.glyphData
  memory.grow(1)
  expect(oldNative.byteLength).toBe(0)
  const words = new Uint32Array(memory.buffer, 30816, 480 * 24)
  words[479 * 24] = 0x7fc54321
  words[479 * 24 + 22] = 0x80000000
  fixture.pass.uploadFrame(source, [update(11, 0, 0, 479 * 96, 96)])
  expect(originalBuffer.byteLength).toBe(0)
  expect(fixture.writes[1]!.sourceBuffer === memory.buffer).toBe(true)
  const uploaded = new Uint32Array(fixture.writes[1]!.bytes.buffer)
  expect(uploaded[0]).toBe(0x7fc54321)
  expect(uploaded[22]).toBe(0x80000000)
})
