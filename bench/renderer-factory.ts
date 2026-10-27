import { DomTerminalRenderer } from '../src/render/dom/renderer.js'
import { CanvasTerminalRenderer } from '../src/render/canvas/renderer.js'
import { WebGlTerminalRenderer } from '../src/render/webgl/renderer.js'
import { WebGpuTerminalRenderer } from '../src/render/webgpu/renderer.js'
import type { WebGpuTerminalRendererOptions } from '../src/render/shared/types.js'
import { benchmarkBackends, type BenchmarkBackend } from './renderer-benchmark-types.js'

interface AdapterInfo {
  readonly vendor: string
  readonly architecture: string
  readonly description: string
  readonly fallback: boolean
}

export function parseBenchmarkBackend(value: string): BenchmarkBackend {
  const backend = benchmarkBackends.find((candidate) => candidate === value)
  if (backend) return backend
  throw new Error(`Unknown benchmark backend: ${value}`)
}

export async function createBenchmarkRenderer(
  backend: Exclude<BenchmarkBackend, 'ghostty-web'>,
  options: WebGpuTerminalRendererOptions,
) {
  if (backend === 'dom')
    return { renderer: await DomTerminalRenderer.create(options), adapter: null, path: 'dom' }
  if (backend === 'canvas2d') {
    const renderer = await CanvasTerminalRenderer.create(options)
    return { renderer, adapter: null, path: renderer.canvasPaintMode }
  }
  if (backend === 'canvas2d-pixels') {
    const renderer = await CanvasTerminalRenderer.create({
      ...options,
      rendererMode: 'canvas2d-pixels',
    })
    return {
      renderer,
      adapter: null,
      path: renderer.canvasPaintMode,
    }
  }
  if (backend === 'webgl2')
    return {
      renderer: await WebGlTerminalRenderer.create(options),
      adapter: null,
      path: 'instanced',
    }

  if (new URL(location.href).searchParams.has('defaultGpu')) {
    const renderer = await WebGpuTerminalRenderer.create(options)
    const device: unknown = Reflect.get(renderer, 'device')
    if (!(device instanceof GPUDevice)) throw new Error('GPU device required')
    const info = device.adapterInfo
    return {
      renderer,
      adapter: {
        vendor: info.vendor,
        architecture: info.architecture,
        description: info.description,
        fallback: info.isFallbackAdapter,
      },
      path: 'instanced-shared-default',
    }
  }
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No WebGPU adapter')
  const info: AdapterInfo = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    description: adapter.info.description,
    fallback: adapter.info.isFallbackAdapter,
  }
  const timestamp = new URL(location.href).searchParams.has('timestamp')
  const device = await adapter.requestDevice({
    requiredFeatures: timestamp && adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
  })
  return {
    renderer: await WebGpuTerminalRenderer.create({
      ...options,
      deviceFactory: async () => device,
    }),
    adapter: info,
    path: 'instanced',
  }
}
