import type { GhosttyRuntime } from '../core/runtime.js'
import type {
  SelectionCoordinates,
  SelectionDragEvent,
  SelectionPoint,
  SelectionPressEvent,
} from '../core/selection.js'
import type {
  RgbColor,
  RuntimeOptions,
  TerminalCursor,
  TerminalCursorStyle,
  TerminalScrollbar,
} from '../core/types.js'
import type { RendererTheme } from '../render/instances/types.js'
import type { RenderStateSource } from '../render/renderer.js'
import type { LinkRequest, LinkResolverOptions } from './links.js'

type RendererColorKey =
  | 'background'
  | 'cursor'
  | 'foreground'
  | 'selectionBackground'
  | 'selectionForeground'

export type TerminalColor = Readonly<RgbColor>

export type TerminalColorScheme = 'dark' | 'light'

export type TerminalRendererTheme = Readonly<
  Omit<RendererTheme, RendererColorKey> & Record<RendererColorKey, TerminalColor>
>

export interface TerminalGrid {
  readonly cellHeight: number
  readonly cellWidth: number
  readonly columns: number
  readonly pixelRatio: number
  readonly rows: number
}

export interface TerminalFontSettings {
  readonly boldWeight: number
  readonly family: string
  readonly letterSpacing: number
  readonly lineHeight: number
  readonly size: number
  readonly weight: number
}

export interface TerminalFittedFont {
  readonly charLeft: number
  readonly charTop: number
  readonly cssCellHeight: number
  readonly cssCellWidth: number
  readonly deviceBaseline: number
  readonly deviceCellHeight: number
  readonly deviceCellWidth: number
  readonly deviceCharHeight: number
  readonly deviceCharWidth: number
  readonly pixelRatio: number
  readonly settings: TerminalFontSettings
}

export interface TerminalCursorSettings {
  readonly blink: boolean
  readonly style: TerminalCursorStyle
}

export type TerminalTheme = TerminalRendererTheme & {
  /** The session validates and copies exactly 256 entries. */
  readonly palette: readonly TerminalColor[]
}

export interface TerminalAppearance {
  readonly colorScheme: TerminalColorScheme
  readonly cursor: TerminalCursorSettings
  readonly font: TerminalFontSettings
  readonly grid: TerminalGrid
  readonly rendererTheme: TerminalRendererTheme
  readonly scrollbackLimit: number | undefined
  readonly theme: TerminalTheme
}

export interface TerminalAppearanceOptions {
  readonly colorScheme?: TerminalColorScheme
  readonly cursor?: Partial<TerminalCursorSettings>
  readonly font?: Partial<TerminalFontSettings>
  readonly grid?: Partial<TerminalGrid>
  readonly scrollbackLimit?: number
  readonly theme?: TerminalTheme
}

export type TerminalSessionRuntime =
  | {
      readonly kind: 'borrowed'
      readonly runtime: GhosttyRuntime
    }
  | {
      readonly kind: 'owned'
      readonly options?: RuntimeOptions
    }

export type TerminalClipboardLocation = 'primary' | 'selection' | 'standard'

export interface TerminalClipboardRepresentation {
  readonly data: Uint8Array
  readonly mime: string
}

export interface TerminalClipboardWrite {
  readonly contents: readonly TerminalClipboardRepresentation[]
  readonly location: TerminalClipboardLocation
}

export type TerminalClipboardWriteResult =
  | 'busy'
  | 'denied'
  | 'invalid-data'
  | 'io-error'
  | 'success'
  | 'unsupported'

export type TerminalClipboardWritePolicy = (
  write: TerminalClipboardWrite,
) => TerminalClipboardWriteResult

export interface TerminalSessionOptions<TEvent = unknown> {
  readonly appearance?: TerminalAppearanceOptions
  readonly clipboardWrite?: TerminalClipboardWritePolicy
  readonly links?: LinkResolverOptions<TEvent>
  readonly runtime?: TerminalSessionRuntime
}

export type TerminalInputData = string | Uint8Array

export type TerminalKeyAction = 'press' | 'release' | 'repeat'

export type TerminalModifierSide = 'left' | 'right' | 'unknown'

export interface TerminalModifiers {
  readonly alt?: TerminalModifierSide
  readonly capsLock?: boolean
  readonly control?: TerminalModifierSide
  readonly numLock?: boolean
  readonly shift?: TerminalModifierSide
  readonly super?: TerminalModifierSide
}

export interface TerminalKeyInput {
  readonly action: TerminalKeyAction
  /** W3C physical-key `code`; unsupported values map to `Unidentified`. */
  readonly code: string
  readonly composing: boolean
  readonly consumedModifiers?: TerminalModifiers
  readonly modifiers?: TerminalModifiers
  readonly text: string
}

export type TerminalMouseAction = 'motion' | 'press' | 'release'

export type TerminalMouseButton =
  | 'eight'
  | 'eleven'
  | 'five'
  | 'four'
  | 'left'
  | 'middle'
  | 'nine'
  | 'right'
  | 'seven'
  | 'six'
  | 'ten'
  | 'unknown'

export interface TerminalMouseGeometry {
  readonly cellHeight: number
  readonly cellWidth: number
  readonly paddingBottom: number
  readonly paddingLeft: number
  readonly paddingRight: number
  readonly paddingTop: number
  readonly screenHeight: number
  readonly screenWidth: number
}

export interface TerminalMouseEvent {
  readonly action: TerminalMouseAction
  readonly button: TerminalMouseButton | null
  readonly modifiers?: TerminalModifiers
  readonly x: number
  readonly y: number
}

export interface TerminalMouseState {
  readonly anyButtonPressed: boolean
  readonly geometry: TerminalMouseGeometry
}

export interface TerminalMouseInput {
  readonly event: TerminalMouseEvent
  readonly state: TerminalMouseState
}

export type TerminalSelectionPressInput = Readonly<SelectionPressEvent>

export type TerminalSelectionDragInput = Readonly<SelectionDragEvent>

export type TerminalSelectionReleaseInput = Readonly<SelectionPoint>

export type TerminalLinkRequest = Readonly<Omit<LinkRequest, 'osc8Range' | 'osc8Uri'>>

export type TerminalInputResult = Uint8Array

export interface TerminalMutationResult {
  readonly revision: number
}

export type TerminalCursorSnapshot = Readonly<TerminalCursor>

export interface TerminalDataEvent {
  readonly bytes: Uint8Array
}

export interface TerminalTitleEvent {
  readonly title: string
}

export type TerminalBellEvent = void

export interface TerminalResizeEvent {
  readonly grid: TerminalGrid
}

export interface TerminalSelectionEvent {
  readonly coordinates?: Readonly<SelectionCoordinates>
  readonly hasSelection: boolean
}

export interface TerminalScrollEvent {
  readonly scrollbackLength: number
  readonly scrollbar: Readonly<TerminalScrollbar>
  readonly viewportActive: boolean
}

export interface TerminalRenderRequestEvent extends TerminalMutationResult {
  readonly state: RenderStateSource
}

export interface TerminalErrorEvent {
  readonly cause: unknown
  readonly operation: string
}

export interface TerminalAppearanceEvent {
  readonly appearance: TerminalAppearance
}

export interface TerminalSessionEventMap {
  readonly appearance: TerminalAppearanceEvent
  readonly bell: TerminalBellEvent
  readonly data: TerminalDataEvent
  readonly error: TerminalErrorEvent
  readonly renderRequest: TerminalRenderRequestEvent
  readonly resize: TerminalResizeEvent
  readonly scroll: TerminalScrollEvent
  readonly selection: TerminalSelectionEvent
  readonly title: TerminalTitleEvent
}

export type TerminalSessionEventType = keyof TerminalSessionEventMap

export type TerminalSessionListener<TType extends TerminalSessionEventType> = (
  event: TerminalSessionEventMap[TType],
) => void

export interface TerminalSessionSubscription {
  dispose(): void
}
