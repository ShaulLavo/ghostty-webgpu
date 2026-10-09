import { createGhosttyError } from '../core/error.js'
import type { AtlasGpuTextures } from './atlas/gpu-textures.js'
import type { RowInstanceUpdate } from './instances/types.js'
import {
  planSparseUploadRanges,
  planUploadRanges,
  planWrappedUploadRanges,
  type UploadPlan,
} from './instances/upload-ranges.js'
import { CELL_INSTANCE_BYTES, GLYPH_INSTANCE_BYTES } from './instances/layout.js'
import { cellShader } from './shaders/cell.wgsl.js'
import { glyphShader } from './shaders/glyph.wgsl.js'

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

type FrameRows =
  | {
      readonly stableRows?: false
      readonly columns?: number
      readonly rowHeight?: number
      readonly rowOffset?: number
    }
  | {
      readonly stableRows: boolean
      readonly columns: number
      readonly rowHeight: number
      readonly rowOffset: number
    }

interface PipelineResources {
  cellBindGroup: GPUBindGroup
  cellPipeline: GPURenderPipeline
  glyphPipeline: GPURenderPipeline
}

interface GlyphBatch {
  readonly buffer: GPUBuffer
  readonly byteOffset: number
  readonly instanceCount: number
  bindGroup?: GPUBindGroup
}

export function textPassGlyphCapacity(device: GPUDevice, instanceCount: number): number {
  const byteLimit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)
  const cellBytes = instanceCount * CELL_INSTANCE_BYTES
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 1 || cellBytes > byteLimit) {
    throw createGhosttyError(
      'webgpu_capacity',
      `The grid needs ${cellBytes} cell-storage bytes; this WebGPU device supports ${byteLimit}`,
    )
  }
  const capacity = Math.floor(byteLimit / GLYPH_INSTANCE_BYTES)
  if (capacity < 1) {
    throw createGhosttyError(
      'webgpu_capacity',
      `A native glyph record needs ${GLYPH_INSTANCE_BYTES} bytes; this WebGPU device supports ${byteLimit}`,
    )
  }
  return capacity
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
  private readonly glyphBatches: GlyphBatch[] = []
  readonly drawCount: number
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
  private readonly rowData = new ArrayBuffer(24)
  private readonly rowView = new DataView(this.rowData)
  private rowOffset = 0
  private rowHeight = 0
  private rowColumns = 0
  private rowsInitialized = false
  private wrapRow = Infinity
  private editPlanner: (updates: readonly RowInstanceUpdate[], wrapRow: number) => UploadPlan =
    planUploadRanges

  constructor(options: WebGpuTextPassOptions) {
    this.device = options.device
    this.instanceCount = options.instanceCount
    const capacity = textPassGlyphCapacity(this.device, this.instanceCount)
    try {
      this.cellBuffer = this.createStorageBuffer(this.instanceCount * CELL_INSTANCE_BYTES)
      for (let first = 0; first < this.instanceCount; first += capacity) {
        const instanceCount = Math.min(capacity, this.instanceCount - first)
        this.glyphBatches.push({
          buffer: this.createStorageBuffer(instanceCount * GLYPH_INSTANCE_BYTES),
          byteOffset: first * GLYPH_INSTANCE_BYTES,
          instanceCount,
        })
      }
      this.glyphBuffer = this.glyphBatches[0]!.buffer
      this.drawCount = 1 + this.glyphBatches.length
      this.viewportBuffer = options.device.createBuffer({
        size: 32,
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
    for (const batch of this.glyphBatches) {
      batch.bindGroup = this.device.createBindGroup({
        entries: [
          { binding: 0, resource: { buffer: batch.buffer } },
          { binding: 1, resource: { buffer: this.viewportBuffer } },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: textures.view('grayscale') },
          { binding: 4, resource: textures.view('color') },
        ],
        layout: this.resources.glyphPipeline.getBindGroupLayout(0),
      })
      this.glyphBindGroupCreationCountValue += 1
    }
    this.glyphBindGroup = this.glyphBatches[0]!.bindGroup
  }

  get glyphBindGroupCreationCount(): number {
    return this.glyphBindGroupCreationCountValue
  }

  get frameUploadedBytes(): number {
    return this.frameUploadedBytesValue
  }

  uploadFrame(
    data: FrameRows & {
      readonly cellData: Float32Array
      readonly glyphData: Float32Array
      readonly rowChanges?: number
    },
    updates: readonly RowInstanceUpdate[],
  ): number {
    this.frameUploadedBytesValue = 0
    const changes = data.rowChanges ?? 0
    if (!this.rowsInitialized || changes !== 0) {
      this.uploadRows(data)
      this.rowsInitialized = true
    }
    const plan =
      (changes & 1) === 0
        ? this.editPlanner(updates, this.wrapRow)
        : planSparseUploadRanges(updates)
    const cellData = data.cellData
    const glyphData = data.glyphData
    for (const range of plan.cell) this.writeRange(this.cellBuffer, cellData, range)
    if (this.glyphBatches.length === 1) {
      for (const range of plan.glyph) this.writeRange(this.glyphBuffer, glyphData, range)
      return plan.cell.length + plan.glyph.length
    }
    let operations = plan.cell.length
    for (const range of plan.glyph) operations += this.writeGlyphRange(glyphData, range)
    return operations
  }

  submit(view: GPUTextureView, copy?: TextPassCopy): void {
    this.device.queue.submit([this.encode(view, copy)])
    this.acceptFrame()
  }

  acceptFrame(): void {
    this.metrics.draws += this.drawCount
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
    pass.draw(6, this.glyphBatches[0]!.instanceCount)
    for (let index = 1; index < this.glyphBatches.length; index += 1) {
      const batch = this.glyphBatches[index]!
      pass.setBindGroup(0, batch.bindGroup!)
      pass.draw(6, batch.instanceCount)
    }
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

  private uploadRows(data: FrameRows): void {
    const columns = data.stableRows ? data.columns : 0
    const height = data.stableRows ? data.rowHeight : 0
    const offset = data.stableRows ? data.rowOffset : 0
    if (columns === this.rowColumns && height === this.rowHeight && offset === this.rowOffset)
      return
    this.rowColumns = columns
    this.rowHeight = height
    this.rowOffset = offset
    this.wrapRow = offset === 0 ? Infinity : this.instanceCount / columns - offset
    this.editPlanner = offset === 0 ? planUploadRanges : planWrappedUploadRanges
    this.rowView.setUint32(0, columns, true)
    this.rowView.setFloat32(4, height, true)
    this.rowView.setUint32(8, offset, true)
    this.rowView.setUint32(12, this.instanceCount, true)
    this.device.queue.writeBuffer(this.viewportBuffer, 8, this.rowData)
    this.frameUploadedBytesValue += this.rowData.byteLength
    this.metrics.uploadedBytes += this.rowData.byteLength
    this.metrics.uploadOperations += 1
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

  private writeGlyphRange(
    data: Float32Array,
    range: { byteLength: number; byteOffset: number },
  ): number {
    let operations = 0
    for (const batch of this.glyphBatches) {
      const start = Math.max(range.byteOffset, batch.byteOffset)
      const end = Math.min(
        range.byteOffset + range.byteLength,
        batch.byteOffset + batch.instanceCount * GLYPH_INSTANCE_BYTES,
      )
      if (end <= start) continue
      this.writeRange(
        batch.buffer,
        data,
        { byteOffset: start - batch.byteOffset, byteLength: end - start },
        start,
      )
      operations += 1
    }
    return operations
  }

  private writeRange(
    buffer: GPUBuffer,
    data: Float32Array | Uint32Array,
    range: { byteLength: number; byteOffset: number },
    sourceOffset = range.byteOffset,
  ): void {
    if (range.byteLength === 0) return
    this.device.queue.writeBuffer(
      buffer,
      range.byteOffset,
      data.buffer,
      data.byteOffset + sourceOffset,
      range.byteLength,
    )
    this.frameUploadedBytesValue += range.byteLength
    this.metrics.uploadedBytes += range.byteLength
    this.metrics.uploadOperations += 1
  }
}
