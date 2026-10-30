import type { ExtensionInput } from '../extensions/types.js'
import type { EventSubscription } from '../term/events.js'
import type { LinkResolverOptions } from '../term/links.js'
import type {
  TerminalAppearance,
  TerminalAppearanceOptions,
  TerminalColorScheme,
  TerminalCursorSettings,
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalFittedFont,
  TerminalFontSettings,
  TerminalInputData,
  TerminalMutationResult,
  TerminalRendererTheme,
  TerminalScrollEvent,
  TerminalSelectionEvent,
  TerminalSessionRuntime,
  TerminalTheme,
} from '../term/types.js'
import type { RendererTheme } from '../render/shared/instances/types.js'
import type { InactiveCursorStyle } from '../render/shared/cursor.js'
import type {
  RendererFrameSnapshot,
  RendererGridSize,
  WebGpuTerminalRendererOptions,
} from '../render/shared/types.js'
import type { TerminalWriteQueueOptions } from './write-queue.js'
import type { TerminalLigatures } from '../render/shared/ligatures/finder.js'
import type { TerminalAccessibilityOptions } from './accessibility.js'
import type { DomClipboardWritePolicy } from './clipboard.js'
import type { TerminalElementPaddingInput, TerminalElements } from './elements.js'
import type { TerminalFitEnvironment } from './fit.js'
import type { TerminalPointerOwner } from './pointer.js'
import type { TerminalScrollbarControllerOptions } from './scrollbar.js'

export type GhosttyWebGpuTerminalLifecycle =
  | 'created'
  | 'disposed'
  | 'disposing'
  | 'open'
  | 'opening'

export interface GhosttyWebGpuTerminalResizeEvent {
  readonly cols: number
  readonly rows: number
}

/**
 * One burst of output: writes that arrive with less than `quietMs` between them. All times are
 * `performance.now()` values in this window's clock.
 */
export interface TerminalOutputTiming {
  /** The last typed, pasted, mouse or `sendInput` input within `inputWindowMs` before this output began. */
  readonly inputAt?: number
  readonly firstOutputAt: number
  readonly lastOutputAt: number
  /**
   * When the first frame holding the last output was drawn: WebGPU commands submitted, WebGL or
   * canvas draw calls issued, or DOM rows written. In a worker terminal, when the frame's notice
   * reached this window. Missing when no frame drew it, such as output that changed nothing visible.
   */
  readonly drawnAt?: number
  /**
   * When the browser finished the page update that carries the drawn frame: the first task after
   * that update. The display shows it at its next refresh. A desynchronized canvas can appear
   * before this. Missing in worker terminals and when `drawnAt` is missing.
   */
  readonly presentedAt?: number
  readonly writes: number
  /** No frame drew this output because the terminal was hidden when it ended. */
  readonly hidden: boolean
  readonly presentation: NonNullable<GhosttyWebGpuTerminalOptions['presentation']>
  /** The canvas presents without waiting for the browser's compositor, as `diagnostics.desynchronized`. */
  readonly desynchronized: boolean
  readonly rendererBackend: 'dom' | 'canvas2d' | 'webgl2' | 'webgpu' | undefined
}

export interface GhosttyWebGpuTerminalOutputTimingOptions {
  /** Output that pauses for this many milliseconds ends a burst. Defaults to 100. */
  readonly quietMs?: number
  /** Input older than this many milliseconds when output begins is not paired with it. Defaults to 2000. */
  readonly inputWindowMs?: number
}

export interface GhosttyWebGpuTerminalEventMap {
  readonly open: HTMLDivElement
  readonly appearance: TerminalAppearance
  readonly bell: void
  readonly data: TerminalDataEvent
  readonly frame: { readonly rows: readonly number[] }
  readonly error: TerminalErrorEvent
  /** Fires once per output burst after it is drawn. Timing is recorded only while someone listens. */
  readonly outputTiming: TerminalOutputTiming
  readonly resize: GhosttyWebGpuTerminalResizeEvent
  readonly scroll: TerminalScrollEvent
  readonly selection: TerminalSelectionEvent
  readonly title: string
}

export type GhosttyWebGpuTerminalEventType = keyof GhosttyWebGpuTerminalEventMap

export type GhosttyWebGpuTerminalListener<TType extends GhosttyWebGpuTerminalEventType> = (
  event: GhosttyWebGpuTerminalEventMap[TType],
) => unknown

export type GhosttyWebGpuTerminalSubscription = EventSubscription

export type GhosttyWebGpuTerminalCopy = (text: string) => PromiseLike<void> | void

export type TerminalGeneratedInput =
  | { readonly type: 'key'; readonly input: import('../term/types.js').TerminalKeyInput }
  | { readonly type: 'text' | 'paste'; readonly data: TerminalInputData }
  | { readonly type: 'composition'; readonly text: string }

export interface TerminalInputConnection {
  readonly signal: AbortSignal
  dispose(): void
}

export interface TerminalInputModes {
  readonly alternateScreen: boolean
  readonly mouseReporting: boolean
}

export interface GhosttyWebGpuTerminalDiagnostics {
  readonly hasPendingFrame: boolean
  readonly hasPendingLinkResolution: boolean
  readonly hasPendingTimer: boolean
  readonly lifecycle: GhosttyWebGpuTerminalLifecycle
  readonly pointerOwner: TerminalPointerOwner
  readonly pressedButtonCount: number
  readonly rendererBackend: 'dom' | 'canvas2d' | 'webgl2' | 'webgpu' | undefined
  /** The renderer's context reports `desynchronized`; the browser may still composite it. */
  readonly desynchronized: boolean
  readonly scrollbarVisible: boolean
}

export type GhosttyWebGpuTerminalAccessibilityOptions = Omit<
  TerminalAccessibilityOptions,
  'root' | 'signal' | 'textarea'
>

export type GhosttyWebGpuTerminalScrollbarOptions = Omit<
  TerminalScrollbarControllerOptions,
  'actions' | 'onError' | 'root' | 'signal' | 'snapshot'
>

export interface GhosttyWebGpuRenderer {
  /** Required to settle clean updates through onCleanUpdate. */
  readonly canPaint?: boolean
  readonly backend?: 'dom' | 'canvas2d' | 'webgl2' | 'webgpu'
  readonly desynchronized?: boolean
  readonly hasPendingFrame?: boolean
  readonly hasPendingTimer?: boolean
  clearTextureAtlas?(): void
  dispose(): void
  notifyScroll(): void
  notifySelectionChange(): void
  notifyWrite(): void
  refreshRows?(startRow: number, endRow: number): void
  resize(grid: RendererGridSize): void
  schedule(): void
  setCursorBlinkEnabled(enabled: boolean): void
  setDocumentVisible(visible: boolean): void
  setReducedMotion?(reduced: boolean): void
  setFocused(focused: boolean): void
  setInactiveCursorStyle?(style: InactiveCursorStyle | undefined): void
  setFont(font: TerminalFittedFont): void
  setTheme(theme: Partial<RendererTheme>): void
}

export type GhosttyWebGpuRendererFactory = (
  options: WebGpuTerminalRendererOptions,
  signal: AbortSignal,
) => Promise<GhosttyWebGpuRenderer>

export interface GhosttyWebGpuTerminalOptions {
  /** Reorder cells with Unicode 13.0 BiDi tables. Defaults to false. */
  readonly bidi?: boolean
  readonly accessibility?: false | GhosttyWebGpuTerminalAccessibilityOptions
  readonly appearance?: TerminalAppearanceOptions
  readonly clipboardWrite?: DomClipboardWritePolicy
  /** URL for the Canvas 2D pixel compositor. Main-thread terminals only. */
  readonly compositorAsset?: string | URL
  readonly copySelection?: GhosttyWebGpuTerminalCopy
  readonly fitEnvironment?: Partial<TerminalFitEnvironment>
  readonly keyboard?: boolean
  readonly extensions?: readonly ExtensionInput[]
  readonly linkActivationModifier?: (event: MouseEvent) => boolean
  readonly links?: LinkResolverOptions<Event>
  readonly outputTiming?: GhosttyWebGpuTerminalOutputTimingOptions
  readonly padding?: TerminalElementPaddingInput
  /** Keep painting outside the viewport or clipping ancestors. Defaults to false. */
  readonly renderWhenOffscreen?: boolean
  readonly rendererFactory?: GhosttyWebGpuRendererFactory
  /** Opt-in SGR 5/6 animation; false by default, matching native Ghostty. */
  readonly textBlink?: boolean
  /** Opt-in programming ligatures, off by default. See docs/api.md for run splitting rules. */
  readonly ligatures?: TerminalLigatures
  readonly rendererMode?: WebGpuTerminalRendererOptions['rendererMode']
  /** `immediate` paints a write before the next display frame; main-thread terminals only. */
  readonly presentation?: WebGpuTerminalRendererOptions['presentation']
  readonly runtime?: TerminalSessionRuntime
  /** `false` removes the scrollbar and its reserved width; wheel and keyboard scrolling still work. */
  readonly scrollbar?: GhosttyWebGpuTerminalScrollbarOptions | false
  readonly writeQueue?: TerminalWriteQueueOptions
}

export interface GhosttyWebGpuTerminalInputHooks {
  beforeUserInput?(): void
  inputReady?(): void
  inputDisabled?(): boolean
  macOptionIsMeta?(): boolean
  onKey?(event: KeyboardEvent, data: Uint8Array): void
  screenReaderMode?(): boolean
}

export interface GhosttyWebGpuTerminalPointerHooks {
  allowPointerEvent?(event: PointerEvent | WheelEvent): boolean
  customWheelEvent?(event: WheelEvent): boolean
}

export interface GhosttyWebGpuTerminalFromSessionOptions extends GhosttyWebGpuTerminalOptions {
  readonly autoFit?: boolean
  readonly elements?: TerminalElements
  readonly inputHooks?: GhosttyWebGpuTerminalInputHooks
  readonly pointerHooks?: GhosttyWebGpuTerminalPointerHooks
}

export interface GhosttyWebGpuTerminalAppearanceApi {
  setAppearance?(options: TerminalAppearanceOptions): TerminalMutationResult
  setColorScheme(colorScheme: TerminalColorScheme): void
  setCursor(cursor: Partial<TerminalCursorSettings>): void
  setFont(font: Partial<TerminalFontSettings>): void
  setTheme(theme: TerminalTheme): void
}

export interface GhosttyWebGpuFrameHandler {
  (snapshot: RendererFrameSnapshot): void
}

export type GhosttyWebGpuThemeProjection = TerminalRendererTheme
