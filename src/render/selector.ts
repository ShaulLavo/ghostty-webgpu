import { CanvasTerminalRenderer } from './canvas/renderer.js'
import { FallbackTerminalRenderer } from './fallback.js'
import {
  WebGpuTerminalRenderer,
  WebGpuUnavailableError,
  type WebGpuTerminalRendererOptions,
} from './renderer.js'
import { WebGlTerminalRenderer, WebGlUnavailableError } from './webgl/renderer.js'

export type CompatibleTerminalRenderer =
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
  try {
    return await WebGpuTerminalRenderer.create(options)
  } catch (cause) {
    if (!(cause instanceof WebGpuUnavailableError)) throw cause
  }
  signal?.throwIfAborted()
  try {
    if (options.replaceCanvas) {
      return await FallbackTerminalRenderer.create(options, options.replaceCanvas, signal)
    }
    return await WebGlTerminalRenderer.create(options)
  } catch (cause) {
    if (!(cause instanceof WebGlUnavailableError)) throw cause
  }
  signal?.throwIfAborted()
  return CanvasTerminalRenderer.create(options)
}
