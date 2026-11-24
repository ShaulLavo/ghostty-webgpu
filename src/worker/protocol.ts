import type { LocalTerminalExecution } from '../dom/execution-local.js'
import type { TerminalElementPadding } from '../dom/elements.js'
import type { TerminalSubmittedSnapshot } from '../dom/submitted-frame.js'
import type { RendererTextFrameSnapshot } from '../render/shared/types.js'
import type { InactiveCursorStyle } from '../render/shared/cursor.js'
import type {
  TerminalAppearance,
  TerminalAppearanceOptions,
  TerminalFittedFont,
  TerminalSessionEventMap,
} from '../term/types.js'
import type { WorkerFailure } from './structured-errors.js'

export const workerOperationTimeout = 15_000

export type WorkerBackend = 'auto' | 'webgpu' | 'webgl'
export interface WorkerFontFace {
  readonly family: string
  readonly source: { readonly url: string } | { readonly bytes: Uint8Array }
  readonly descriptors?: Readonly<FontFaceDescriptors>
}
export interface WorkerAssets {
  readonly wasm: string
  readonly bridge: string
}
export interface WorkerLayout {
  readonly identity: number
  readonly width: number
  readonly height: number
  readonly pixelRatio: number
  readonly padding: TerminalElementPadding
  readonly scrollbarWidth: number
  readonly autoFit: boolean
}
interface WorkerIdentity {
  readonly terminal: string
  readonly generation: number
}
interface WorkerWatermarks extends WorkerIdentity {
  readonly control: number
  readonly output: number
}
export interface WorkerState {
  readonly renderHeld: boolean
  readonly appearance: TerminalAppearance
  readonly scrollbar: LocalTerminalExecution['scrollbar']
  readonly revision: number
  readonly mouseTracking: boolean
  readonly backend?: 'webgpu' | 'webgl2'
}
/** Wire state: the appearance travels only when its identity changed since the last message. */
export type WorkerStateUpdate = Omit<WorkerState, 'appearance'> & {
  readonly appearance?: TerminalAppearance
}
export interface WorkerSubmission extends WorkerWatermarks {
  readonly type: 'frame'
  readonly mouseTracking: boolean
  readonly base: number
  readonly summary: TerminalSubmittedSnapshot
  readonly snapshot: RendererTextFrameSnapshot
}

export interface WorkerFrameDelta extends Omit<WorkerSubmission, 'snapshot' | 'summary'> {
  readonly snapshot: Omit<RendererTextFrameSnapshot, 'rows'>
  // Font and theme travel only when their identity changed since the previous frame.
  readonly summary: Omit<TerminalSubmittedSnapshot, 'rows' | 'rowPatches' | 'font' | 'theme'> &
    Partial<Pick<TerminalSubmittedSnapshot, 'font' | 'theme'>>
  readonly order: readonly number[]
  readonly patches: readonly number[]
  readonly buffer: ArrayBuffer
}

type NativeCommands = Pick<
  LocalTerminalExecution,
  | 'geometry'
  | 'measure'
  | 'measureTexts'
  | 'writeAndReadGeometry'
  | 'write'
  | 'writeln'
  | 'sendInput'
  | 'paste'
  | 'key'
  | 'reset'
  | 'lineCount'
  | 'readLines'
  | 'scrollToTop'
  | 'scrollToBottom'
  | 'scrollBy'
  | 'scrollWheel'
  | 'scrollToRow'
  | 'getSelection'
  | 'selectionCoordinates'
  | 'selectionSnapshot'
  | 'selectionPress'
  | 'selectionDrag'
  | 'selectionAutoscrollTick'
  | 'selectionRelease'
  | 'resetSelectionGesture'
  | 'mouse'
  | 'resetMouseTracking'
  | 'clearSelection'
  | 'selectAll'
  | 'selectRange'
  | 'selectLines'
  | 'frameSnapshot'
  | 'resolveLinkSnapshot'
  | 'resolveLinkDiscovery'
  | 'captureViewport'
  | 'setAppearance'
>
export interface WorkerCommands extends NativeCommands {
  open(canvas: OffscreenCanvas, layout: WorkerLayout): TerminalFittedFont
  layout(layout: WorkerLayout): void
  focused(focused: boolean): void
  visible(visible: boolean): void
  reducedMotion(reduced: boolean): void
  inactiveCursor(style: InactiveCursorStyle | undefined): boolean
  refresh(start: number, end: number): void
  clearTextureAtlas(): void
  attachOutput(port: MessagePort): void
  fence(): void
  dispose(): void
}
export type WorkerCommand = keyof WorkerCommands
export type WorkerRequest = {
  [K in WorkerCommand]: WorkerWatermarks & {
    readonly type: 'request'
    readonly id: number
    readonly command: K
    readonly args: Parameters<WorkerCommands[K]>
  }
}[WorkerCommand]
interface WorkerReply extends WorkerWatermarks {
  readonly type: 'reply'
  readonly id: number
  readonly state: WorkerStateUpdate
  readonly result?: unknown
  readonly failure?: WorkerFailure
}
type WorkerEventName = Exclude<keyof TerminalSessionEventMap, 'renderRequest'>
// An appearance event carries no payload: the host emits the appearance its state confirmed.
type WorkerEvent = {
  [K in WorkerEventName]: WorkerWatermarks & {
    readonly type: 'event'
    readonly event: K
    readonly value: K extends 'appearance' ? undefined : TerminalSessionEventMap[K]
    readonly state: WorkerStateUpdate
  }
}[WorkerEventName]
export interface WorkerCanvasReplacement extends WorkerIdentity {
  readonly type: 'canvas'
  readonly canvas: OffscreenCanvas
}

export type WorkerMessage<Frame extends WorkerSubmission | WorkerFrameDelta = WorkerSubmission> =
  | WorkerReply
  | WorkerEvent
  | Frame
  | (WorkerWatermarks & { readonly type: 'replaceCanvas' })
  | (WorkerWatermarks & {
      readonly type: 'fatal'
      readonly failure: WorkerFailure
    })
export interface WorkerInitialize extends WorkerIdentity {
  readonly type: 'initialize'
  readonly port: MessagePort
  readonly assets: WorkerAssets
  readonly faces: readonly WorkerFontFace[]
  readonly appearance?: TerminalAppearanceOptions
  readonly backend: WorkerBackend
  /** The page owns a pooled worker's lifetime; a dedicated worker closes itself on stop. */
  readonly pooled?: boolean
  readonly bidi?: boolean
  readonly textBlink?: boolean
  readonly ligatures?: boolean | { readonly font: string | ArrayBuffer | ArrayBufferView }
}

/** A producer transfers only buffers it owns. Its sequence starts at one per attached port. */
export interface TerminalOutputMessage extends WorkerIdentity {
  readonly type: 'output'
  readonly sequence: number
  readonly data: Uint8Array
}
export interface TerminalOutputReady extends WorkerIdentity {
  readonly type: 'ready'
}
export interface TerminalOutputAck extends WorkerIdentity {
  readonly type: 'output-ack'
  readonly sequence: number
}

export const workerCommandNames: ReadonlySet<string> = new Set([
  'geometry',
  'measure',
  'measureTexts',
  'writeAndReadGeometry',
  'write',
  'writeln',
  'sendInput',
  'paste',
  'key',
  'reset',
  'lineCount',
  'readLines',
  'scrollToTop',
  'scrollToBottom',
  'scrollBy',
  'scrollWheel',
  'scrollToRow',
  'getSelection',
  'selectionCoordinates',
  'selectionSnapshot',
  'selectionPress',
  'selectionDrag',
  'selectionAutoscrollTick',
  'selectionRelease',
  'resetSelectionGesture',
  'mouse',
  'resetMouseTracking',
  'clearSelection',
  'selectAll',
  'selectRange',
  'selectLines',
  'frameSnapshot',
  'resolveLinkSnapshot',
  'resolveLinkDiscovery',
  'captureViewport',
  'setAppearance',
  'open',
  'layout',
  'focused',
  'visible',
  'reducedMotion',
  'inactiveCursor',
  'refresh',
  'clearTextureAtlas',
  'attachOutput',
  'fence',
  'dispose',
])
