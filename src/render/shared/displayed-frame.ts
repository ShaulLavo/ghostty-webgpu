import type { NativeDisplayedFrame } from '../../core/displayed-frame.js'
import type {
  RendererTextFrameRow,
  RendererTextFrameSnapshot,
  WebGpuTerminalRendererOptions,
} from './types.js'

export const retainDisplayedFrame = Symbol('retainDisplayedFrame')
export const captureRenderAcknowledgement = Symbol('captureRenderAcknowledgement')
export const observeDisplayedFrame = Symbol('observeDisplayedFrame')

export interface DisplayedTextFrame extends RendererTextFrameSnapshot {
  readonly nativeFrame?: NativeDisplayedFrame
  readonly previousTextRows?: readonly RendererTextFrameRow[]
}

export interface DisplayedFrameSource {
  [retainDisplayedFrame]?(options?: { full?: boolean }): NativeDisplayedFrame
}

export interface DisplayedFrameOptions {
  [observeDisplayedFrame]?: (snapshot: DisplayedTextFrame) => void
}

export function displayedFrameListener(options: WebGpuTerminalRendererOptions) {
  return (options as DisplayedFrameOptions)[observeDisplayedFrame] ?? options.onTextFrame
}
