import { cellShader } from '../shaders/cell.wgsl.js'
import { glyphShader } from '../shaders/glyph.wgsl.js'

export interface TextPipelines {
  readonly cellLayout: GPUBindGroupLayout
  readonly cellPipeline: GPURenderPipeline
  readonly glyphLayout: GPUBindGroupLayout
  readonly glyphPipeline: GPURenderPipeline
  readonly sampler: GPUSampler
}

// Pipelines hold no per-terminal state, so every pass on a device and format reuses one set.
const cache = new WeakMap<GPUDevice, Map<GPUTextureFormat, TextPipelines>>()

export function textPipelines(device: GPUDevice, format: GPUTextureFormat): TextPipelines {
  let formats = cache.get(device)
  if (!formats) {
    formats = new Map()
    cache.set(device, formats)
  }
  const existing = formats.get(format)
  if (existing) return existing
  const created = createTextPipelines(device, format)
  formats.set(format, created)
  return created
}

function blendState(): GPUBlendState {
  return {
    alpha: { dstFactor: 'one-minus-src-alpha', srcFactor: 'one' },
    color: { dstFactor: 'one-minus-src-alpha', srcFactor: 'one' },
  }
}

function createPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  code: string,
): GPURenderPipeline {
  const module = device.createShaderModule({ code })
  return device.createRenderPipeline({
    fragment: { entryPoint: 'fragmentMain', module, targets: [{ blend: blendState(), format }] },
    layout: 'auto',
    primitive: { topology: 'triangle-list' },
    vertex: { entryPoint: 'vertexMain', module },
  })
}

function createTextPipelines(device: GPUDevice, format: GPUTextureFormat): TextPipelines {
  const cellPipeline = createPipeline(device, format, cellShader)
  const glyphPipeline = createPipeline(device, format, glyphShader)
  return {
    cellLayout: cellPipeline.getBindGroupLayout(0),
    cellPipeline,
    glyphLayout: glyphPipeline.getBindGroupLayout(0),
    glyphPipeline,
    sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
  }
}
