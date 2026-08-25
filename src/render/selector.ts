import { CanvasTerminalRenderer } from './canvas/renderer.js'
import {
  WebGpuTerminalRenderer,
  WebGpuUnavailableError,
  type WebGpuTerminalRendererOptions,
} from './renderer.js'

export type CompatibleTerminalRenderer = CanvasTerminalRenderer | WebGpuTerminalRenderer

export async function createCompatibleTerminalRenderer(
  options: WebGpuTerminalRendererOptions,
  _signal?: AbortSignal,
): Promise<CompatibleTerminalRenderer> {
  try {
    return await WebGpuTerminalRenderer.create(options)
  } catch (cause) {
    if (!(cause instanceof WebGpuUnavailableError)) throw cause
    return CanvasTerminalRenderer.create(options)
  }
}
