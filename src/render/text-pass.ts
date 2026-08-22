import type { AtlasGpuTextures } from './atlas/gpu-textures.js'
import type { RowInstanceUpdate } from './instances/types.js'
import type { InstanceRows } from './instances/rows.js'
import { backgroundShader } from './shaders/background.wgsl.js'
import { glyphShader } from './shaders/glyph.wgsl.js'

export interface TextPassMetrics {
  draws: number
  submittedFrames: number
  uploadedBytes: number
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
  backgroundBindGroup: GPUBindGroup
  backgroundPipeline: GPURenderPipeline
  glyphPipeline: GPURenderPipeline
}

function blendState(): GPUBlendState {
  return {
    alpha: { dstFactor: 'one-minus-src-alpha', srcFactor: 'one' },
    color: { dstFactor: 'one-minus-src-alpha', srcFactor: 'one' },
  }
}

function createFallbackTexture(device: GPUDevice): GPUTexture {
  return device.createTexture({
    format: 'rgba8unorm',
    size: [1, 1],
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  })
}

export class WebGpuTextPass {
  private readonly backgroundBuffer: GPUBuffer
  private readonly device: GPUDevice
  private readonly fallbackColor: GPUTexture
  private readonly fallbackGrayscale: GPUTexture
  private readonly glyphBuffer: GPUBuffer
  private glyphBindGroup?: GPUBindGroup
  private readonly instanceCount: number
  readonly metrics: TextPassMetrics = { draws: 0, submittedFrames: 0, uploadedBytes: 0 }
  private readonly resources: PipelineResources
  private readonly sampler: GPUSampler
  private readonly viewportBuffer: GPUBuffer

  constructor(options: WebGpuTextPassOptions) {
    this.device = options.device
    this.instanceCount = options.instanceCount
    this.backgroundBuffer = this.createStorageBuffer(options.instanceCount * 32)
    this.glyphBuffer = this.createStorageBuffer(options.instanceCount * 96)
    this.viewportBuffer = options.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    })
    this.sampler = options.device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    this.fallbackGrayscale = createFallbackTexture(options.device)
    this.fallbackColor = createFallbackTexture(options.device)
    options.device.queue.writeBuffer(
      this.viewportBuffer,
      0,
      new Float32Array([options.width, options.height, 0, 0]),
    )
    this.resources = this.createPipelines(options.format)
  }

  syncAtlas(textures: AtlasGpuTextures): void {
    const grayscale = textures.view('grayscale') ?? this.fallbackGrayscale.createView()
    const color = textures.view('color') ?? this.fallbackColor.createView()
    this.glyphBindGroup = this.device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: this.glyphBuffer } },
        { binding: 1, resource: { buffer: this.viewportBuffer } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: grayscale },
        { binding: 4, resource: color },
      ],
      layout: this.resources.glyphPipeline.getBindGroupLayout(0),
    })
  }

  upload(instances: InstanceRows, updates: readonly RowInstanceUpdate[]): void {
    for (const update of updates) {
      this.writeRange(this.backgroundBuffer, instances.backgroundData, update.background)
      this.writeRange(this.glyphBuffer, instances.glyphData, update.glyph)
    }
  }

  submit(view: GPUTextureView, copy?: TextPassCopy): void {
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
    pass.setPipeline(this.resources.backgroundPipeline)
    pass.setBindGroup(0, this.resources.backgroundBindGroup)
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
    this.device.queue.submit([encoder.finish()])
    this.metrics.draws += 2
    this.metrics.submittedFrames += 1
  }

  destroy(): void {
    this.backgroundBuffer.destroy()
    this.glyphBuffer.destroy()
    this.viewportBuffer.destroy()
    this.fallbackGrayscale.destroy()
    this.fallbackColor.destroy()
  }

  private createPipelines(format: GPUTextureFormat): PipelineResources {
    const backgroundPipeline = this.device.createRenderPipeline({
      fragment: {
        entryPoint: 'fragmentMain',
        module: this.device.createShaderModule({ code: backgroundShader }),
        targets: [{ blend: blendState(), format }],
      },
      layout: 'auto',
      primitive: { topology: 'triangle-list' },
      vertex: {
        entryPoint: 'vertexMain',
        module: this.device.createShaderModule({ code: backgroundShader }),
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
    const backgroundBindGroup = this.device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: this.backgroundBuffer } },
        { binding: 1, resource: { buffer: this.viewportBuffer } },
      ],
      layout: backgroundPipeline.getBindGroupLayout(0),
    })
    return { backgroundBindGroup, backgroundPipeline, glyphPipeline }
  }

  private createStorageBuffer(size: number): GPUBuffer {
    return this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    })
  }

  private writeRange(
    buffer: GPUBuffer,
    data: Float32Array,
    range: { byteLength: number; byteOffset: number },
  ): void {
    this.device.queue.writeBuffer(
      buffer,
      range.byteOffset,
      data.buffer,
      range.byteOffset,
      range.byteLength,
    )
    this.metrics.uploadedBytes += range.byteLength
  }
}
