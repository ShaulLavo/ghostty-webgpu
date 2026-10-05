import type { AtlasGpuTextures } from './atlas/gpu-textures.js'
import type { RowInstanceUpdate } from './instances/types.js'
import { planUploadRanges } from './instances/upload-ranges.js'
import {
  CELL_INSTANCE_BYTES,
  GLYPH_INSTANCE_BYTES,
  GLYPH_INSTANCE_FLOATS,
} from './instances/layout.js'
import { cellShader } from './shaders/cell.wgsl.js'
import { glyphShader } from './shaders/glyph.wgsl.js'

const GPU_GLYPH_INSTANCE_FLOATS = 20
const GPU_GLYPH_INSTANCE_BYTES = GPU_GLYPH_INSTANCE_FLOATS * Uint32Array.BYTES_PER_ELEMENT

export interface TextPassMetrics {
  draws: number
  submittedFrames: number
  uploadedBytes: number
  uploadOperations: number
}

export interface WebGpuTextPassOptions {
  device: GPUDevice
  format: GPUTextureFormat
  height: number
  instanceCount: number
  width: number
}

export interface TextPassCopy {
  buffer: GPUBuffer
  bytesPerRow: number
  size: GPUExtent3DStrict
  texture: GPUTexture
}

interface PipelineResources {
  cellBindGroup: GPUBindGroup
  cellPipeline: GPURenderPipeline
  glyphPipeline: GPURenderPipeline
}

function blendState(): GPUBlendState {
  return {
    alpha: { dstFactor: 'one-minus-src-alpha', srcFactor: 'one' },
    color: { dstFactor: 'one-minus-src-alpha', srcFactor: 'one' },
  }
}

export class WebGpuTextPass {
  private readonly ownedBuffers: GPUBuffer[] = []
  private readonly cellBuffer: GPUBuffer
  private readonly device: GPUDevice
  private readonly glyphBuffer: GPUBuffer
  private readonly glyphUploadWords: Uint32Array
  private frameUploadedBytesValue = 0
  private glyphBindGroupCreationCountValue = 0
  private glyphBindGroup?: GPUBindGroup
  private readonly instanceCount: number
  readonly metrics: TextPassMetrics = {
    draws: 0,
    submittedFrames: 0,
    uploadedBytes: 0,
    uploadOperations: 0,
  }
  private readonly resources: PipelineResources
  private readonly sampler: GPUSampler
  private readonly viewportBuffer: GPUBuffer

  constructor(options: WebGpuTextPassOptions) {
    this.device = options.device
    this.instanceCount = options.instanceCount
    try {
      this.cellBuffer = this.createStorageBuffer(options.instanceCount * CELL_INSTANCE_BYTES)
      this.glyphBuffer = this.createStorageBuffer(options.instanceCount * GPU_GLYPH_INSTANCE_BYTES)
      this.glyphUploadWords = new Uint32Array(options.instanceCount * GPU_GLYPH_INSTANCE_FLOATS)
      this.viewportBuffer = options.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
      })
      this.ownedBuffers.push(this.viewportBuffer)
      this.sampler = options.device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
      options.device.queue.writeBuffer(
        this.viewportBuffer,
        0,
        new Float32Array([options.width, options.height, 0, 0]),
      )
      this.resources = this.createPipelines(options.format)
    } catch (cause) {
      this.destroy()
      throw cause
    }
  }

  syncAtlas(textures: AtlasGpuTextures): void {
    this.glyphBindGroup = this.device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: this.glyphBuffer } },
        { binding: 1, resource: { buffer: this.viewportBuffer } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: textures.view('grayscale') },
        { binding: 4, resource: textures.view('color') },
      ],
      layout: this.resources.glyphPipeline.getBindGroupLayout(0),
    })
    this.glyphBindGroupCreationCountValue += 1
  }

  get glyphBindGroupCreationCount(): number {
    return this.glyphBindGroupCreationCountValue
  }

  get frameUploadedBytes(): number {
    return this.frameUploadedBytesValue
  }

  uploadFrame(
    data: { readonly cellData: Float32Array; readonly glyphData: Float32Array },
    updates: readonly RowInstanceUpdate[],
  ): number {
    this.frameUploadedBytesValue = 0
    const plan = planUploadRanges(updates)
    const cellData = data.cellData
    const glyphData = data.glyphData
    for (const range of plan.cell) this.writeRange(this.cellBuffer, cellData, range)
    const glyphWords = new Uint32Array(glyphData.buffer, glyphData.byteOffset, glyphData.length)
    for (const range of plan.glyph) {
      this.packGlyphRange(glyphWords, range)
      this.writeRange(this.glyphBuffer, this.glyphUploadWords, {
        byteOffset: (range.byteOffset / GLYPH_INSTANCE_BYTES) * GPU_GLYPH_INSTANCE_BYTES,
        byteLength: (range.byteLength / GLYPH_INSTANCE_BYTES) * GPU_GLYPH_INSTANCE_BYTES,
      })
    }
    return plan.cell.length + plan.glyph.length
  }

  submit(view: GPUTextureView, copy?: TextPassCopy): void {
    this.device.queue.submit([this.encode(view, copy)])
    this.acceptFrame()
  }

  acceptFrame(): void {
    this.metrics.draws += 2
    this.metrics.submittedFrames += 1
  }

  encode(view: GPUTextureView, copy?: TextPassCopy): GPUCommandBuffer {
    if (!this.glyphBindGroup) throw new Error('Atlas textures must be synchronized before drawing')
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          clearValue: { a: 0, b: 0, g: 0, r: 0 },
          loadOp: 'clear',
          storeOp: 'store',
          view,
        },
      ],
    })
    pass.setPipeline(this.resources.cellPipeline)
    pass.setBindGroup(0, this.resources.cellBindGroup)
    pass.draw(6, this.instanceCount)
    pass.setPipeline(this.resources.glyphPipeline)
    pass.setBindGroup(0, this.glyphBindGroup)
    pass.draw(6, this.instanceCount)
    pass.end()
    if (copy) {
      encoder.copyTextureToBuffer(
        { texture: copy.texture },
        { buffer: copy.buffer, bytesPerRow: copy.bytesPerRow },
        copy.size,
      )
    }
    return encoder.finish()
  }

  destroy(): void {
    for (const buffer of this.ownedBuffers) buffer.destroy()
  }

  private createPipelines(format: GPUTextureFormat): PipelineResources {
    const cellPipeline = this.device.createRenderPipeline({
      fragment: {
        entryPoint: 'fragmentMain',
        module: this.device.createShaderModule({ code: cellShader }),
        targets: [{ blend: blendState(), format }],
      },
      layout: 'auto',
      primitive: { topology: 'triangle-list' },
      vertex: {
        entryPoint: 'vertexMain',
        module: this.device.createShaderModule({ code: cellShader }),
      },
    })
    const glyphPipeline = this.device.createRenderPipeline({
      fragment: {
        entryPoint: 'fragmentMain',
        module: this.device.createShaderModule({ code: glyphShader }),
        targets: [{ blend: blendState(), format }],
      },
      layout: 'auto',
      primitive: { topology: 'triangle-list' },
      vertex: {
        entryPoint: 'vertexMain',
        module: this.device.createShaderModule({ code: glyphShader }),
      },
    })
    const cellBindGroup = this.device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: this.cellBuffer } },
        { binding: 1, resource: { buffer: this.viewportBuffer } },
      ],
      layout: cellPipeline.getBindGroupLayout(0),
    })
    return { cellBindGroup, cellPipeline, glyphPipeline }
  }

  private createStorageBuffer(size: number): GPUBuffer {
    const buffer = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    })
    this.ownedBuffers.push(buffer)
    return buffer
  }

  private packGlyphRange(
    source: Uint32Array,
    range: { readonly byteLength: number; readonly byteOffset: number },
  ): void {
    const first = range.byteOffset / GLYPH_INSTANCE_BYTES
    const end = first + range.byteLength / GLYPH_INSTANCE_BYTES
    const target = this.glyphUploadWords
    for (let slot = first; slot < end; slot += 1) {
      const input = slot * GLYPH_INSTANCE_FLOATS
      const output = slot * GPU_GLYPH_INSTANCE_FLOATS
      for (let word = 0; word < 16; word += 1) target[output + word] = source[input + word]!
      // Native atlas generations remain in CPU records for retained-glyph validation.
      target[output + 16] = source[input + 16]!
      target[output + 17] = source[input + 18]!
      target[output + 18] = source[input + 20]!
      target[output + 19] = source[input + 22]!
    }
  }

  private writeRange(
    buffer: GPUBuffer,
    data: Float32Array | Uint32Array,
    range: { byteLength: number; byteOffset: number },
  ): void {
    if (range.byteLength === 0) return
    this.device.queue.writeBuffer(
      buffer,
      range.byteOffset,
      data.buffer,
      data.byteOffset + range.byteOffset,
      range.byteLength,
    )
    this.frameUploadedBytesValue += range.byteLength
    this.metrics.uploadedBytes += range.byteLength
    this.metrics.uploadOperations += 1
  }
}
