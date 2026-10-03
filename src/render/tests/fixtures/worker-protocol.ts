import type { RendererMetrics } from '../../renderer.js'
import type { TerminalCursorSnapshot } from '../../../term/types.js'

export type WorkerBackend = 'webgpu' | 'webgl'

export interface WorkerRenderRequest {
  readonly backend: WorkerBackend
  readonly canvas: OffscreenCanvas
  readonly output: MessagePort
  readonly fontUrl: string
  readonly wasmUrl: string
  readonly bridgeUrl: string
  readonly failAfterFrame: boolean
}

export interface WorkerObservation {
  readonly globalType: string
  readonly windowType: string
  readonly fontLoaded: boolean
  readonly glyphInk: boolean
  readonly text: string
  readonly cursor: TerminalCursorSnapshot
  readonly key: readonly number[]
  readonly paste: readonly number[]
  readonly metrics: RendererMetrics
  readonly animationFrames: number
}

export interface WorkerCleanup {
  readonly framesBeforeDispose: number
  readonly timersBeforeDispose: number
  readonly frames: number
  readonly timers: number
  readonly fontRemoved: boolean
  readonly outputClosed: boolean
  readonly sessionDisposed: boolean
  readonly backendReleased: boolean
  readonly metrics?: RendererMetrics
}

export type WorkerRenderMessage =
  | { readonly type: 'output-ready' }
  | { readonly type: 'disposed'; readonly cleanup: WorkerCleanup }
  | { readonly type: 'result'; readonly observation: WorkerObservation }
  | { readonly type: 'complete' }

export interface ProducerObservation {
  readonly type: 'sent'
  readonly bufferDetached: boolean
}
