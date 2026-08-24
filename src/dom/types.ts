import type { RegisterableHotkey } from '@tanstack/hotkeys'
import type { EventSubscription } from '../term/events.js'
import type { LinkResolverOptions } from '../term/links.js'
import type {
  TerminalAppearance,
  TerminalAppearanceOptions,
  TerminalColorScheme,
  TerminalCursorSettings,
  TerminalErrorEvent,
  TerminalFittedFont,
  TerminalFontSettings,
  TerminalInputData,
  TerminalInputResult,
  TerminalRendererTheme,
  TerminalScrollEvent,
  TerminalSelectionEvent,
  TerminalSessionRuntime,
  TerminalTheme,
} from '../term/types.js'
import type { RendererTheme } from '../render/instances/types.js'
import type {
  RendererFrameSnapshot,
  RendererGridSize,
  WebGpuTerminalRendererOptions,
} from '../render/renderer.js'
import type { TerminalAccessibilityOptions } from './accessibility.js'
import type { DomClipboardWritePolicy } from './clipboard.js'
import type { TerminalElementPaddingInput } from './elements.js'
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

export interface GhosttyWebGpuTerminalEventMap {
  readonly appearance: TerminalAppearance
  readonly bell: void
  readonly data: Uint8Array
  readonly error: TerminalErrorEvent
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

export type TerminalHotkeyDecision = 'claim' | 'passthrough'

export interface TerminalHotkeyContext {
  readonly event: KeyboardEvent
  readonly getSelection: () => string | undefined
  readonly hasSelection: () => boolean
  readonly paste: (data: TerminalInputData) => TerminalInputResult
  readonly sendInput: (data: TerminalInputData) => TerminalInputResult
}

export interface TerminalHotkeyBinding {
  readonly hotkey: RegisterableHotkey
  readonly id: string
  readonly onTrigger: (context: TerminalHotkeyContext) => TerminalHotkeyDecision
  readonly preventDefault?: boolean
  readonly stopPropagation?: boolean
}

export interface GhosttyWebGpuTerminalKeyboardOptions {
  readonly shortcuts?: false | readonly TerminalHotkeyBinding[]
}

export interface GhosttyWebGpuTerminalDiagnostics {
  readonly hasPendingFrame: boolean
  readonly hasPendingLinkResolution: boolean
  readonly hasPendingTimer: boolean
  readonly lifecycle: GhosttyWebGpuTerminalLifecycle
  readonly pointerOwner: TerminalPointerOwner
  readonly pressedButtonCount: number
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
  readonly hasPendingFrame?: boolean
  readonly hasPendingTimer?: boolean
  dispose(): void
  notifyScroll(): void
  notifySelectionChange(): void
  notifyWrite(): void
  resize(grid: RendererGridSize): void
  schedule(): void
  setCursorBlinkEnabled(enabled: boolean): void
  setDocumentVisible(visible: boolean): void
  setFocused(focused: boolean): void
  setFont(font: TerminalFittedFont): void
  setTheme(theme: Partial<RendererTheme>): void
}

export type GhosttyWebGpuRendererFactory = (
  options: WebGpuTerminalRendererOptions,
  signal: AbortSignal,
) => Promise<GhosttyWebGpuRenderer>

export interface GhosttyWebGpuTerminalOptions {
  readonly accessibility?: GhosttyWebGpuTerminalAccessibilityOptions
  readonly appearance?: TerminalAppearanceOptions
  readonly clipboardWrite?: DomClipboardWritePolicy
  readonly copySelection?: GhosttyWebGpuTerminalCopy
  readonly fitEnvironment?: Partial<TerminalFitEnvironment>
  readonly keyboard?: false | GhosttyWebGpuTerminalKeyboardOptions
  readonly linkActivationModifier?: (event: MouseEvent) => boolean
  readonly links?: LinkResolverOptions<Event>
  readonly padding?: TerminalElementPaddingInput
  readonly rendererFactory?: GhosttyWebGpuRendererFactory
  readonly runtime?: TerminalSessionRuntime
  readonly scrollbar?: GhosttyWebGpuTerminalScrollbarOptions
}

export interface GhosttyWebGpuTerminalAppearanceApi {
  setColorScheme(colorScheme: TerminalColorScheme): void
  setCursor(cursor: Partial<TerminalCursorSettings>): void
  setFont(font: Partial<TerminalFontSettings>): void
  setTheme(theme: TerminalTheme): void
}

export interface GhosttyWebGpuFrameHandler {
  (snapshot: RendererFrameSnapshot): void
}

export type GhosttyWebGpuThemeProjection = TerminalRendererTheme
