import { automaticGpuBackends } from './backend-order.js'
import { DomTerminalRenderer } from './dom/renderer.js'
import { CanvasUnavailableError, CanvasTerminalRenderer } from './canvas/renderer.js'
import { FallbackTerminalRenderer } from './fallback.js'
import {
  WebGpuTerminalRenderer,
  WebGpuUnavailableError,
  type WebGpuTerminalRendererOptions,
} from './renderer.js'
import { WebGlTerminalRenderer } from './webgl/renderer.js'
import { WebGlUnavailableError } from './webgl/unavailable.js'

export type CompatibleTerminalRenderer =
  | DomTerminalRenderer
  | CanvasTerminalRenderer
  | FallbackTerminalRenderer
  | WebGlTerminalRenderer
  | WebGpuTerminalRenderer

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
  if (options.rendererMode && options.rendererMode !== 'auto')
    return CanvasTerminalRenderer.create(options)
  options = { ...options }
  const backends = automaticGpuBackends()
  for (const [index, backend] of backends.entries()) {
    signal?.throwIfAborted()
    try {
      if (backend === 'webgpu')
        return await WebGpuTerminalRenderer.create({ ...options, adapterPolicy: 'hardware' })
      if (options.replaceCanvas)
        return await FallbackTerminalRenderer.create(
          options,
          options.replaceCanvas,
          signal,
          backends.slice(index + 1),
        )
      return await WebGlTerminalRenderer.create(options)
    } catch (cause) {
      if (!(cause instanceof WebGpuUnavailableError || cause instanceof WebGlUnavailableError))
        throw cause
      if (cause instanceof WebGlUnavailableError && cause.canvasClaimed) {
        signal?.throwIfAborted()
        options.canvas = replaceClaimedCanvas(options, cause)
      }
    }
  }
  signal?.throwIfAborted()
  try {
    return await CanvasTerminalRenderer.create(options)
  } catch (cause) {
    if (!(cause instanceof CanvasUnavailableError)) throw cause
  }
  signal?.throwIfAborted()
  return DomTerminalRenderer.create(options)
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
