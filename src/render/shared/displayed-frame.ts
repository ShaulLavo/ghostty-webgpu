import type { NativeDisplayedFrame } from '../../core/displayed-frame.js'
import {
  attachCanvasImage,
  observeDisplayedFrame,
  retainDisplayedFrame,
} from '../../core/frame-observers.js'
export {
  attachCanvasImage,
  captureRenderAcknowledgement,
  observeDisplayedFrame,
  retainDisplayedFrame,
} from '../../core/frame-observers.js'
import type {
  RendererTextFrameRow,
  RendererTextFrameSnapshot,
  WebGpuTerminalRendererOptions,
} from './types.js'

export interface DisplayedTextFrame extends RendererTextFrameSnapshot {
  readonly nativeFrame?: NativeDisplayedFrame
  readonly previousTextRows?: readonly RendererTextFrameRow[]
}

export interface DisplayedFrameSource {
  [retainDisplayedFrame]?(options?: { full?: boolean }): NativeDisplayedFrame
}

export interface CanvasImagePublisher {
  notify(isCurrent: () => boolean): void
  dispose(): void
}

export interface DisplayedFrameOptions {
  [attachCanvasImage]?: () => CanvasImagePublisher
  [observeDisplayedFrame]?: (snapshot: DisplayedTextFrame) => void
}

export function displayedFrameListener(options: WebGpuTerminalRendererOptions) {
  return (options as DisplayedFrameOptions)[observeDisplayedFrame] ?? options.onTextFrame
}
