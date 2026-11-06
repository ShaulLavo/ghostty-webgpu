import type { NativeDisplayedFrame } from '../../core/displayed-frame.js'
import {
  attachCanvasImage,
  captureDisplayedRows,
  displayedRows,
  capturedSubmission,
  captureSubmission,
  type DisplayedRows,
  observeDisplayedFrame,
  retainDisplayedFrame,
} from '../../core/frame-observers.js'
export {
  attachCanvasImage,
  captureDisplayedRows,
  displayedRows,
  capturedSubmission,
  captureSubmission,
  type DisplayedRows,
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
  readonly [displayedRows]?: DisplayedRows
  readonly [capturedSubmission]?: object
  readonly nativeFrame?: NativeDisplayedFrame
  readonly previousTextRows?: readonly RendererTextFrameRow[]
}

export interface DisplayedFrameSource {
  [captureDisplayedRows]?(): DisplayedRows
  [retainDisplayedFrame]?(options?: { full?: boolean }): NativeDisplayedFrame
}

export interface CanvasImagePublisher {
  notify(isCurrent: () => boolean): void
  dispose(): void
}

export interface DisplayedFrameOptions {
  [captureSubmission]?: () => object
  [attachCanvasImage]?: () => CanvasImagePublisher
  [observeDisplayedFrame]?: (snapshot: DisplayedTextFrame) => void
}

export function displayedFrameListener(options: WebGpuTerminalRendererOptions) {
  return (options as DisplayedFrameOptions)[observeDisplayedFrame] ?? options.onTextFrame
}
