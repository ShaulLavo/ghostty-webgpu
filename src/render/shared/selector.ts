import { automaticGpuBackends, type GpuBackend } from './backend-order.js'
import type { DomTerminalRenderer } from '../dom/renderer.js'
import type { CanvasTerminalRenderer } from '../canvas/renderer.js'
import type { FallbackTerminalRenderer } from './fallback.js'
import type { WebGpuTerminalRendererOptions } from './types.js'
import type { WebGpuTerminalRenderer } from '../webgpu/renderer.js'
import type { WebGlTerminalRenderer } from '../webgl/renderer.js'
import { prefetchComposeKernel } from '../pixels/kernel-source.js'
import { WebGlUnavailableError } from '../webgl/unavailable.js'
import { startupCanvas, type DisplayedFrameOptions } from './displayed-frame.js'
import { StartupTerminalRenderer } from './startup.js'

export type CompatibleTerminalRenderer =
  | DomTerminalRenderer
  | CanvasTerminalRenderer
  | FallbackTerminalRenderer
  | WebGlTerminalRenderer
  | WebGpuTerminalRenderer

const ignoreFailure = (): undefined => undefined

function gpuBackends(
  options: Pick<WebGpuTerminalRendererOptions, 'rendererMode' | 'presentation'>,
): readonly GpuBackend[] {
  if (options.rendererMode === 'webgpu') return ['webgpu']
  if (options.rendererMode === 'webgl2') return ['webgl']
  return automaticGpuBackends(options.presentation)
}

function canvasMode(mode: WebGpuTerminalRendererOptions['rendererMode']): boolean {
  return mode === 'canvas2d-fill-text' || mode === 'canvas2d-pixels'
}

/** Starts downloading the renderer chunks `createCompatibleTerminalRenderer` will need first. */
export function prewarmCompatibleRenderer(
  options: Pick<WebGpuTerminalRendererOptions, 'rendererMode' | 'presentation' | 'compositorAsset'>,
): void {
  // A failed prefetch rejects the same import again when the renderer is created.
  if (canvasMode(options.rendererMode) || options.presentation !== 'immediate') {
    if (options.rendererMode !== 'canvas2d-fill-text') {
      prefetchComposeKernel(options.compositorAsset)
      void import('../pixels/kernel.js').catch(ignoreFailure)
      void import('../pixels/stamp-target.js').catch(ignoreFailure)
    }
    void import('../canvas/renderer.js').catch(ignoreFailure)
  }
  if (canvasMode(options.rendererMode)) return
  if (gpuBackends(options)[0] === 'webgpu') {
    void import('../webgpu/renderer.js').catch(ignoreFailure)
    return
  }
  void import('./fallback.js').catch(ignoreFailure)
  void import('../webgl/renderer.js').catch(ignoreFailure)
}

export async function createStartupTerminalRenderer(
  options: WebGpuTerminalRendererOptions & DisplayedFrameOptions,
  signal: AbortSignal,
): Promise<CompatibleTerminalRenderer | StartupTerminalRenderer> {
  signal.throwIfAborted()
  const host = options[startupCanvas]
  const canvas = options.canvas
  if (!host || !('ownerDocument' in canvas) || options.presentation === 'immediate')
    return createCompatibleTerminalRenderer(options, signal)
  if (canvasMode(options.rendererMode) || !canvas.isConnected)
    return createCompatibleTerminalRenderer(options, signal)
  const renderer = await StartupTerminalRenderer.create({
    canvas,
    createGpu: (target) => createGpuRenderer(target, signal),
    host,
    options,
    signal,
  })
  return renderer ?? createCompatibleTerminalRenderer(options, signal)
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
  if (canvasMode(options.rendererMode)) {
    const { CanvasTerminalRenderer } = await import('../canvas/renderer.js')
    signal?.throwIfAborted()
    return CanvasTerminalRenderer.create(options)
  }
  options = { ...options }
  const gpu = await createGpuRenderer(options, signal)
  if (gpu) return gpu
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

type GpuRenderer = WebGlTerminalRenderer | FallbackTerminalRenderer | WebGpuTerminalRenderer

async function createGpuRenderer(
  options: WebGpuTerminalRendererOptions,
  signal?: AbortSignal,
): Promise<GpuRenderer | undefined> {
  const backends = gpuBackends(options)
  for (const [index, backend] of backends.entries()) {
    signal?.throwIfAborted()
    const webGpu = backend === 'webgpu' ? await import('../webgpu/renderer.js') : undefined
    signal?.throwIfAborted()
    try {
      if (webGpu)
        return await webGpu.WebGpuTerminalRenderer.create({
          ...options,
          adapterPolicy: options.rendererMode === 'webgpu' ? 'any' : 'hardware',
        })
      return await createWebGlRenderer(options, backends.slice(index + 1), signal)
    } catch (cause) {
      if (webGpu && cause instanceof webGpu.WebGpuUnavailableError) continue
      if (!(cause instanceof WebGlUnavailableError)) throw cause
      if (!cause.canvasClaimed) continue
      signal?.throwIfAborted()
      options.canvas = replaceClaimedCanvas(options, cause)
    }
  }
  return undefined
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
