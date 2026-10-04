import type { SelectionCoordinates, SelectionPoint } from '../core/selection.js'
import type { Extension, ExtensionHandle } from '../extensions/types.js'
import type {
  ReadLinesOptions,
  TerminalGeometry,
  TerminalTextMeasurement,
  TerminalLine,
  TerminalSelectionFormatOptions,
} from '../core/types.js'
import type { InactiveCursorStyle } from '../render/cursor.js'
import type { RendererFrameSnapshot } from '../render/renderer.js'
import type { LinkProvider, LinkProviderRegistration } from '../term/links.js'
import type {
  TerminalAppearance,
  TerminalAppearanceOptions,
  TerminalColorScheme,
  TerminalCursorSettings,
  TerminalFontSettings,
  TerminalInputData,
  TerminalInputResult,
  TerminalKeyInput,
  TerminalMutationResult,
  TerminalTheme,
} from '../term/types.js'
import type { TerminalSubmittedFrame } from './submitted-frame.js'
import type {
  GhosttyWebGpuTerminalDiagnostics,
  GhosttyWebGpuTerminalEventType,
  GhosttyWebGpuTerminalLifecycle,
  GhosttyWebGpuTerminalListener,
  GhosttyWebGpuTerminalSubscription,
} from './types.js'

/** Native authority is synchronous locally and acknowledged asynchronously by a worker. */
export type TerminalResult<Mode extends 'sync' | 'async', Value> = Mode extends 'async'
  ? Promise<Value>
  : Value

/** Host operations keep their return convention across execution actors. */
export interface TerminalApi<Mode extends 'sync' | 'async' = 'sync' | 'async'> {
  readonly appearance: TerminalAppearance
  readonly canvas: HTMLCanvasElement | undefined
  readonly diagnostics: GhosttyWebGpuTerminalDiagnostics
  readonly element: HTMLDivElement | undefined
  readonly hasPendingFrame: boolean
  readonly hasPendingLinkResolution: boolean
  readonly hasPendingTimer: boolean
  readonly lifecycle: GhosttyWebGpuTerminalLifecycle
  readonly submittedFrame: TerminalSubmittedFrame | undefined
  readonly textarea: HTMLTextAreaElement | undefined

  open(parent: HTMLElement): Promise<void>
  use<Api = void>(extension: Extension<Api>): TerminalResult<Mode, ExtensionHandle<Api>>
  on<Type extends GhosttyWebGpuTerminalEventType>(
    type: Type,
    listener: GhosttyWebGpuTerminalListener<Type>,
  ): GhosttyWebGpuTerminalSubscription
  onData(listener: GhosttyWebGpuTerminalListener<'data'>): GhosttyWebGpuTerminalSubscription
  onResize(listener: GhosttyWebGpuTerminalListener<'resize'>): GhosttyWebGpuTerminalSubscription
  onFrame(listener: GhosttyWebGpuTerminalListener<'frame'>): GhosttyWebGpuTerminalSubscription
  focus(): void
  blur(): void
  focusNextLink(): Promise<boolean>
  registerLinkProvider(provider: LinkProvider<Event>): LinkProviderRegistration
  setAccessibilityEnabled(enabled: boolean): boolean
  visibleLines(): readonly string[]

  geometry(): TerminalResult<Mode, TerminalGeometry>
  measure(text: string): TerminalResult<Mode, number>
  measureTexts(texts: readonly string[]): TerminalResult<Mode, TerminalTextMeasurement>
  writeAndReadGeometry(data: TerminalInputData): TerminalResult<Mode, TerminalGeometry>
  frameSnapshot(): TerminalResult<Mode, RendererFrameSnapshot | undefined>
  captureViewport(): TerminalResult<Mode, string | undefined>
  lineCount(): TerminalResult<Mode, number>
  readLines(
    start: number,
    end: number,
    options?: ReadLinesOptions,
  ): TerminalResult<Mode, readonly TerminalLine[]>
  write(data: TerminalInputData): TerminalResult<Mode, TerminalMutationResult>
  writeln(data: TerminalInputData): TerminalResult<Mode, TerminalMutationResult>
  sendInput(data: TerminalInputData): TerminalResult<Mode, TerminalInputResult>
  paste(data: TerminalInputData): TerminalResult<Mode, TerminalInputResult>
  key(input: TerminalKeyInput): TerminalResult<Mode, TerminalInputResult>
  reset(): TerminalResult<Mode, TerminalMutationResult>
  refresh(startRow: number, endRow: number): TerminalResult<Mode, void>
  clearTextureAtlas(): TerminalResult<Mode, void>
  scrollToTop(): TerminalResult<Mode, TerminalMutationResult>
  scrollToBottom(): TerminalResult<Mode, TerminalMutationResult>
  scrollBy(delta: number): TerminalResult<Mode, TerminalMutationResult>
  scrollToRow(row: number): TerminalResult<Mode, TerminalMutationResult>
  getSelection(options?: TerminalSelectionFormatOptions): TerminalResult<Mode, string | undefined>
  selectionCoordinates(): TerminalResult<Mode, Readonly<SelectionCoordinates> | undefined>
  clearSelection(): TerminalResult<Mode, boolean>
  selectAll(): TerminalResult<Mode, boolean>
  selectRange(start: SelectionPoint, end: SelectionPoint): TerminalResult<Mode, boolean>
  selectLines(startRow: number, endRow: number): TerminalResult<Mode, boolean>
  setColorScheme(colorScheme: TerminalColorScheme): TerminalResult<Mode, TerminalMutationResult>
  setCursor(cursor: Partial<TerminalCursorSettings>): TerminalResult<Mode, TerminalMutationResult>
  setCursorInactiveStyle(style: InactiveCursorStyle | undefined): TerminalResult<Mode, boolean>
  setFont(font: Partial<TerminalFontSettings>): TerminalResult<Mode, TerminalMutationResult>
  setTheme(theme: TerminalTheme): TerminalResult<Mode, TerminalMutationResult>
  setAppearance(options: TerminalAppearanceOptions): TerminalResult<Mode, TerminalMutationResult>
  dispose(): TerminalResult<Mode, void>
}
