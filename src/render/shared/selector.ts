import { automaticGpuBackends, type GpuBackend } from './backend-order.js'
import type { DomTerminalRenderer } from '../dom/renderer.js'
import type { CanvasTerminalRenderer } from '../canvas/renderer.js'
import type { FallbackTerminalRenderer } from './fallback.js'
import type { WebGpuTerminalRendererOptions } from './types.js'
import type { WebGpuTerminalRenderer } from '../webgpu/renderer.js'
import type { WebGlTerminalRenderer } from '../webgl/renderer.js'
import { WebGlUnavailableError } from '../webgl/unavailable.js'

export type CompatibleTerminalRenderer =
  | DomTerminalRenderer
  | CanvasTerminalRenderer
  | FallbackTerminalRenderer
  | WebGlTerminalRenderer
  | WebGpuTerminalRenderer

const ignoreFailure = (): undefined => undefined

/** Starts downloading the renderer chunks `createCompatibleTerminalRenderer` will need first. */
export function prewarmCompatibleRenderer(
  options: Pick<WebGpuTerminalRendererOptions, 'rendererMode' | 'presentation'>,
): void {
  // A failed prefetch rejects the same import again when the renderer is created.
  if (options.rendererMode && options.rendererMode !== 'auto') {
    void import('../canvas/renderer.js').catch(ignoreFailure)
    if (options.rendererMode !== 'canvas2d-pixels') return
    void import('../pixels/kernel.js').catch(ignoreFailure)
    void import('../pixels/stamp-target.js').catch(ignoreFailure)
    return
  }
  if (automaticGpuBackends(options.presentation)[0] === 'webgpu') {
    void import('../webgpu/renderer.js').catch(ignoreFailure)
    return
  }
  void import('./fallback.js').catch(ignoreFailure)
  void import('../webgl/renderer.js').catch(ignoreFailure)
}

export async function createCompatibleTerminalRenderer(
  options: WebGpuTerminalRendererOptions,
  signal?: AbortSignal,
): Promise<CompatibleTerminalRenderer> {
  signal?.throwIfAborted()
  const renderer = await createRenderer(options, signal)
  if (signal?.aborted) {
    renderer.dispose()
    signal.throwIfAborted()
  }
  return renderer
}

async function createRenderer(
  options: WebGpuTerminalRendererOptions,
  signal?: AbortSignal,
): Promise<CompatibleTerminalRenderer> {
  if (options.rendererMode && options.rendererMode !== 'auto') {
    const { CanvasTerminalRenderer } = await import('../canvas/renderer.js')
    signal?.throwIfAborted()
    return CanvasTerminalRenderer.create(options)
  }
  options = { ...options }
  const backends = automaticGpuBackends(options.presentation)
  for (const [index, backend] of backends.entries()) {
    signal?.throwIfAborted()
    const webGpu = backend === 'webgpu' ? await import('../webgpu/renderer.js') : undefined
    signal?.throwIfAborted()
    try {
      if (webGpu)
        return await webGpu.WebGpuTerminalRenderer.create({ ...options, adapterPolicy: 'hardware' })
      return await createWebGlRenderer(options, backends.slice(index + 1), signal)
    } catch (cause) {
      if (webGpu && cause instanceof webGpu.WebGpuUnavailableError) continue
      if (!(cause instanceof WebGlUnavailableError)) throw cause
      if (!cause.canvasClaimed) continue
      signal?.throwIfAborted()
      options.canvas = replaceClaimedCanvas(options, cause)
    }
  }
  signal?.throwIfAborted()
  const { CanvasTerminalRenderer, CanvasUnavailableError } = await import('../canvas/renderer.js')
  signal?.throwIfAborted()
  try {
    return await CanvasTerminalRenderer.create(options)
  } catch (cause) {
    if (!(cause instanceof CanvasUnavailableError)) throw cause
  }
  signal?.throwIfAborted()
  const { DomTerminalRenderer } = await import('../dom/renderer.js')
  signal?.throwIfAborted()
  return DomTerminalRenderer.create(options)
}

async function createWebGlRenderer(
  options: WebGpuTerminalRendererOptions,
  remainingBackends: readonly GpuBackend[],
  signal?: AbortSignal,
): Promise<WebGlTerminalRenderer | FallbackTerminalRenderer> {
  if (options.replaceCanvas) {
    // Fetch the WebGL chunk alongside the wrapper instead of after it.
    const [{ FallbackTerminalRenderer }] = await Promise.all([
      import('./fallback.js'),
      import('../webgl/renderer.js'),
    ])
    signal?.throwIfAborted()
    return FallbackTerminalRenderer.create(
      options,
      options.replaceCanvas,
      signal,
      remainingBackends,
    )
  }
  const { WebGlTerminalRenderer } = await import('../webgl/renderer.js')
  signal?.throwIfAborted()
  return WebGlTerminalRenderer.create(options)
}

function replaceClaimedCanvas(
  options: WebGpuTerminalRendererOptions,
  cause: WebGlUnavailableError,
): HTMLCanvasElement | OffscreenCanvas {
  if (options.replaceCanvas) return options.replaceCanvas()
  const canvas = options.canvas
  if (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement))
    throw cause
  const replacement = canvas.cloneNode(false) as HTMLCanvasElement
  canvas.replaceWith(replacement)
  return replacement
}
