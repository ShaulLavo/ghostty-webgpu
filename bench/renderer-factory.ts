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

  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No WebGPU adapter')
  const info: AdapterInfo = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    description: adapter.info.description,
    fallback: adapter.info.isFallbackAdapter,
  }
  const device = await adapter.requestDevice()
  return {
    renderer: await WebGpuTerminalRenderer.create({
      ...options,
      deviceFactory: async () => device,
    }),
    adapter: info,
    path: 'instanced',
  }
}
