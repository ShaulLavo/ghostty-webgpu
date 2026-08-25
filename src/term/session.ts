import {
  ClipboardLocation,
  ClipboardWriteResult,
  ColorScheme,
  KeyAction,
  KeyModifier,
  MouseAction,
  MouseButton,
  PhysicalKey,
  TerminalMode,
} from '../core/abi.js'
import { createGhosttyError } from '../core/error.js'
import {
  GhosttyKeyEncoder,
  GhosttyMouseEncoder,
  encodeFocus,
  encodePaste,
  isPasteSafe,
} from '../core/input.js'
import type { MouseEncoderState, NormalizedKeyEvent, NormalizedMouseEvent } from '../core/input.js'
import { GhosttyRenderState } from '../core/render-state.js'
import { GhosttyRuntime } from '../core/runtime.js'
import {
  GhosttySelectionGesture,
  type SelectionCoordinates,
  type SelectionGestureRelease,
  type SelectionGestureUpdate,
  type SelectionPoint,
} from '../core/selection.js'
import { GhosttyTerminal } from '../core/terminal.js'
import { normalizeCellGeometry } from '../core/types.js'
import type {
  ClipboardWrite,
  RgbColor,
  TerminalEffects,
  TerminalScrollbar,
  TerminalSelectionFormatOptions,
  TerminalSize,
} from '../core/types.js'
import { defaultRendererTheme } from '../render/instances/types.js'
import type { RenderStateSource } from '../render/renderer.js'
import { EventEmitter } from './events.js'
import {
  LinkResolver,
  type LinkProvider,
  type LinkProviderRegistration,
  type LinkRange,
  type LinkResolution,
  type LinkResolverError,
  type LinkResolverOptions,
} from './links.js'
import type {
  TerminalAppearance,
  TerminalAppearanceOptions,
  TerminalClipboardLocation,
  TerminalClipboardWrite,
  TerminalClipboardWritePolicy,
  TerminalClipboardWriteResult,
  TerminalColor,
  TerminalColorScheme,
  TerminalCursorSettings,
  TerminalCursorSnapshot,
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalFontSettings,
  TerminalGrid,
  TerminalInputData,
  TerminalInputResult,
  TerminalKeyAction,
  TerminalKeyInput,
  TerminalLinkRequest,
  TerminalMouseInput,
  TerminalMutationResult,
  TerminalModifierSide,
  TerminalModifiers,
  TerminalMouseAction,
  TerminalMouseButton,
  TerminalRendererTheme,
  TerminalScrollEvent,
  TerminalSelectionDragInput,
  TerminalSelectionPressInput,
  TerminalSelectionReleaseInput,
  TerminalSessionEventMap,
  TerminalSessionEventType,
  TerminalSessionListener,
  TerminalSessionOptions,
  TerminalSessionRuntime,
  TerminalSessionSubscription,
  TerminalTheme,
} from './types.js'

const encoder = new TextEncoder()
const paletteLength = 256

const physicalKeyByCode: Readonly<Record<string, PhysicalKey>> = Object.freeze({
  AltLeft: PhysicalKey.AltLeft,
  AltRight: PhysicalKey.AltRight,
  ArrowDown: PhysicalKey.ArrowDown,
  ArrowLeft: PhysicalKey.ArrowLeft,
  ArrowRight: PhysicalKey.ArrowRight,
  ArrowUp: PhysicalKey.ArrowUp,
  AudioVolumeDown: PhysicalKey.AudioVolumeDown,
  AudioVolumeMute: PhysicalKey.AudioVolumeMute,
  AudioVolumeUp: PhysicalKey.AudioVolumeUp,
  Backquote: PhysicalKey.Backquote,
  Backslash: PhysicalKey.Backslash,
  Backspace: PhysicalKey.Backspace,
  BracketLeft: PhysicalKey.BracketLeft,
  BracketRight: PhysicalKey.BracketRight,
  BrowserBack: PhysicalKey.BrowserBack,
  BrowserFavorites: PhysicalKey.BrowserFavorites,
  BrowserForward: PhysicalKey.BrowserForward,
  BrowserHome: PhysicalKey.BrowserHome,
  BrowserRefresh: PhysicalKey.BrowserRefresh,
  BrowserSearch: PhysicalKey.BrowserSearch,
  BrowserStop: PhysicalKey.BrowserStop,
  CapsLock: PhysicalKey.CapsLock,
  Comma: PhysicalKey.Comma,
  ContextMenu: PhysicalKey.ContextMenu,
  ControlLeft: PhysicalKey.ControlLeft,
  ControlRight: PhysicalKey.ControlRight,
  Convert: PhysicalKey.Convert,
  Copy: PhysicalKey.Copy,
  Cut: PhysicalKey.Cut,
  Delete: PhysicalKey.Delete,
  Digit0: PhysicalKey.Digit0,
  Digit1: PhysicalKey.Digit1,
  Digit2: PhysicalKey.Digit2,
  Digit3: PhysicalKey.Digit3,
  Digit4: PhysicalKey.Digit4,
  Digit5: PhysicalKey.Digit5,
  Digit6: PhysicalKey.Digit6,
  Digit7: PhysicalKey.Digit7,
  Digit8: PhysicalKey.Digit8,
  Digit9: PhysicalKey.Digit9,
  Eject: PhysicalKey.Eject,
  End: PhysicalKey.End,
  Enter: PhysicalKey.Enter,
  Equal: PhysicalKey.Equal,
  Escape: PhysicalKey.Escape,
  F1: PhysicalKey.F1,
  F10: PhysicalKey.F10,
  F11: PhysicalKey.F11,
  F12: PhysicalKey.F12,
  F13: PhysicalKey.F13,
  F14: PhysicalKey.F14,
  F15: PhysicalKey.F15,
  F16: PhysicalKey.F16,
  F17: PhysicalKey.F17,
  F18: PhysicalKey.F18,
  F19: PhysicalKey.F19,
  F2: PhysicalKey.F2,
  F20: PhysicalKey.F20,
  F21: PhysicalKey.F21,
  F22: PhysicalKey.F22,
  F23: PhysicalKey.F23,
  F24: PhysicalKey.F24,
  F25: PhysicalKey.F25,
  F3: PhysicalKey.F3,
  F4: PhysicalKey.F4,
  F5: PhysicalKey.F5,
  F6: PhysicalKey.F6,
  F7: PhysicalKey.F7,
  F8: PhysicalKey.F8,
  F9: PhysicalKey.F9,
  Fn: PhysicalKey.Fn,
  FnLock: PhysicalKey.FnLock,
  Help: PhysicalKey.Help,
  Home: PhysicalKey.Home,
  Insert: PhysicalKey.Insert,
  IntlBackslash: PhysicalKey.IntlBackslash,
  IntlRo: PhysicalKey.IntlRo,
  IntlYen: PhysicalKey.IntlYen,
  KanaMode: PhysicalKey.KanaMode,
  KeyA: PhysicalKey.A,
  KeyB: PhysicalKey.B,
  KeyC: PhysicalKey.C,
  KeyD: PhysicalKey.D,
  KeyE: PhysicalKey.E,
  KeyF: PhysicalKey.F,
  KeyG: PhysicalKey.G,
  KeyH: PhysicalKey.H,
  KeyI: PhysicalKey.I,
  KeyJ: PhysicalKey.J,
  KeyK: PhysicalKey.K,
  KeyL: PhysicalKey.L,
  KeyM: PhysicalKey.M,
  KeyN: PhysicalKey.N,
  KeyO: PhysicalKey.O,
  KeyP: PhysicalKey.P,
  KeyQ: PhysicalKey.Q,
  KeyR: PhysicalKey.R,
  KeyS: PhysicalKey.S,
  KeyT: PhysicalKey.T,
  KeyU: PhysicalKey.U,
  KeyV: PhysicalKey.V,
  KeyW: PhysicalKey.W,
  KeyX: PhysicalKey.X,
  KeyY: PhysicalKey.Y,
  KeyZ: PhysicalKey.Z,
  LaunchApp1: PhysicalKey.LaunchApp1,
  LaunchApp2: PhysicalKey.LaunchApp2,
  LaunchMail: PhysicalKey.LaunchMail,
  MediaPlayPause: PhysicalKey.MediaPlayPause,
  MediaSelect: PhysicalKey.MediaSelect,
  MediaStop: PhysicalKey.MediaStop,
  MediaTrackNext: PhysicalKey.MediaTrackNext,
  MediaTrackPrevious: PhysicalKey.MediaTrackPrevious,
  MetaLeft: PhysicalKey.MetaLeft,
  MetaRight: PhysicalKey.MetaRight,
  Minus: PhysicalKey.Minus,
  NonConvert: PhysicalKey.NonConvert,
  NumLock: PhysicalKey.NumLock,
  Numpad0: PhysicalKey.Numpad0,
  Numpad1: PhysicalKey.Numpad1,
  Numpad2: PhysicalKey.Numpad2,
  Numpad3: PhysicalKey.Numpad3,
  Numpad4: PhysicalKey.Numpad4,
  Numpad5: PhysicalKey.Numpad5,
  Numpad6: PhysicalKey.Numpad6,
  Numpad7: PhysicalKey.Numpad7,
  Numpad8: PhysicalKey.Numpad8,
  Numpad9: PhysicalKey.Numpad9,
  NumpadAdd: PhysicalKey.NumpadAdd,
  NumpadBackspace: PhysicalKey.NumpadBackspace,
  NumpadBegin: PhysicalKey.NumpadBegin,
  NumpadClear: PhysicalKey.NumpadClear,
  NumpadClearEntry: PhysicalKey.NumpadClearEntry,
  NumpadComma: PhysicalKey.NumpadComma,
  NumpadDecimal: PhysicalKey.NumpadDecimal,
  NumpadDelete: PhysicalKey.NumpadDelete,
  NumpadDivide: PhysicalKey.NumpadDivide,
  NumpadDown: PhysicalKey.NumpadDown,
  NumpadEnd: PhysicalKey.NumpadEnd,
  NumpadEnter: PhysicalKey.NumpadEnter,
  NumpadEqual: PhysicalKey.NumpadEqual,
  NumpadHome: PhysicalKey.NumpadHome,
  NumpadInsert: PhysicalKey.NumpadInsert,
  NumpadLeft: PhysicalKey.NumpadLeft,
  NumpadMemoryAdd: PhysicalKey.NumpadMemoryAdd,
  NumpadMemoryClear: PhysicalKey.NumpadMemoryClear,
  NumpadMemoryRecall: PhysicalKey.NumpadMemoryRecall,
  NumpadMemoryStore: PhysicalKey.NumpadMemoryStore,
  NumpadMemorySubtract: PhysicalKey.NumpadMemorySubtract,
  NumpadMultiply: PhysicalKey.NumpadMultiply,
  NumpadPageDown: PhysicalKey.NumpadPageDown,
  NumpadPageUp: PhysicalKey.NumpadPageUp,
  NumpadParenLeft: PhysicalKey.NumpadParenLeft,
  NumpadParenRight: PhysicalKey.NumpadParenRight,
  NumpadRight: PhysicalKey.NumpadRight,
  NumpadSeparator: PhysicalKey.NumpadSeparator,
  NumpadSubtract: PhysicalKey.NumpadSubtract,
  NumpadUp: PhysicalKey.NumpadUp,
  PageDown: PhysicalKey.PageDown,
  PageUp: PhysicalKey.PageUp,
  Paste: PhysicalKey.Paste,
  Pause: PhysicalKey.Pause,
  Period: PhysicalKey.Period,
  Power: PhysicalKey.Power,
  PrintScreen: PhysicalKey.PrintScreen,
  Quote: PhysicalKey.Quote,
  ScrollLock: PhysicalKey.ScrollLock,
  Semicolon: PhysicalKey.Semicolon,
  ShiftLeft: PhysicalKey.ShiftLeft,
  ShiftRight: PhysicalKey.ShiftRight,
  Slash: PhysicalKey.Slash,
  Sleep: PhysicalKey.Sleep,
  Space: PhysicalKey.Space,
  Tab: PhysicalKey.Tab,
  Unidentified: PhysicalKey.Unidentified,
  WakeUp: PhysicalKey.WakeUp,
})

const unshiftedCodepointByCode: Readonly<Record<string, number>> = Object.freeze({
  Backquote: 0x60,
  Backslash: 0x5c,
  BracketLeft: 0x5b,
  BracketRight: 0x5d,
  Comma: 0x2c,
  Digit0: 0x30,
  Digit1: 0x31,
  Digit2: 0x32,
  Digit3: 0x33,
  Digit4: 0x34,
  Digit5: 0x35,
  Digit6: 0x36,
  Digit7: 0x37,
  Digit8: 0x38,
  Digit9: 0x39,
  Equal: 0x3d,
  KeyA: 0x61,
  KeyB: 0x62,
  KeyC: 0x63,
  KeyD: 0x64,
  KeyE: 0x65,
  KeyF: 0x66,
  KeyG: 0x67,
  KeyH: 0x68,
  KeyI: 0x69,
  KeyJ: 0x6a,
  KeyK: 0x6b,
  KeyL: 0x6c,
  KeyM: 0x6d,
  KeyN: 0x6e,
  KeyO: 0x6f,
  KeyP: 0x70,
  KeyQ: 0x71,
  KeyR: 0x72,
  KeyS: 0x73,
  KeyT: 0x74,
  KeyU: 0x75,
  KeyV: 0x76,
  KeyW: 0x77,
  KeyX: 0x78,
  KeyY: 0x79,
  KeyZ: 0x7a,
  Minus: 0x2d,
  Period: 0x2e,
  Quote: 0x27,
  Semicolon: 0x3b,
  Slash: 0x2f,
  Space: 0x20,
})

const mouseButtonByName = Object.freeze({
  eight: MouseButton.Eight,
  eleven: MouseButton.Eleven,
  five: MouseButton.Five,
  four: MouseButton.Four,
  left: MouseButton.Left,
  middle: MouseButton.Middle,
  nine: MouseButton.Nine,
  right: MouseButton.Right,
  seven: MouseButton.Seven,
  six: MouseButton.Six,
  ten: MouseButton.Ten,
  unknown: MouseButton.Unknown,
}) satisfies Readonly<Record<TerminalMouseButton, MouseButton>>

function physicalKeyFromCode(code: string): PhysicalKey {
  if (typeof code !== 'string') throw new TypeError('key.code must be a string')
  return physicalKeyByCode[code] ?? PhysicalKey.Unidentified
}

export function isSupportedTerminalKeyCode(code: string): boolean {
  if (code.length === 0 || code === 'Unidentified') return false
  return physicalKeyByCode[code] !== undefined
}

function nativeKeyAction(action: TerminalKeyAction): KeyAction {
  if (action === 'press') return KeyAction.Press
  if (action === 'repeat') return KeyAction.Repeat
  if (action === 'release') return KeyAction.Release
  throw new TypeError(`Unknown key action: ${String(action)}`)
}

function nativeMouseAction(action: TerminalMouseAction): MouseAction {
  if (action === 'press') return MouseAction.Press
  if (action === 'release') return MouseAction.Release
  if (action === 'motion') return MouseAction.Motion
  throw new TypeError(`Unknown mouse action: ${String(action)}`)
}

function nativeMouseButton(button: TerminalMouseButton | null): MouseButton | null {
  if (button === null) return null
  const result = mouseButtonByName[button]
  if (result !== undefined) return result
  throw new TypeError(`Unknown mouse button: ${String(button)}`)
}

function nativeModifier(
  name: string,
  side: TerminalModifierSide | undefined,
  modifier: KeyModifier,
  rightSide: KeyModifier,
): number {
  if (side === undefined) return 0
  if (side === 'left' || side === 'unknown') return modifier
  if (side === 'right') return modifier | rightSide
  throw new TypeError(`Unknown ${name} modifier side: ${String(side)}`)
}

function nativeLock(name: string, active: boolean | undefined, modifier: KeyModifier): number {
  if (active === undefined || active === false) return 0
  if (active === true) return modifier
  throw new TypeError(`${name} modifier must be a boolean`)
}

function nativeModifiers(modifiers: TerminalModifiers | undefined): number {
  if (!modifiers) return 0
  return (
    nativeModifier('shift', modifiers.shift, KeyModifier.Shift, KeyModifier.ShiftSide) |
    nativeModifier('control', modifiers.control, KeyModifier.Control, KeyModifier.ControlSide) |
    nativeModifier('alt', modifiers.alt, KeyModifier.Alt, KeyModifier.AltSide) |
    nativeModifier('super', modifiers.super, KeyModifier.Super, KeyModifier.SuperSide) |
    nativeLock('capsLock', modifiers.capsLock, KeyModifier.CapsLock) |
    nativeLock('numLock', modifiers.numLock, KeyModifier.NumLock)
  )
}

function unshiftedCodepoint(code: string): number {
  return unshiftedCodepointByCode[code] ?? 0
}

export function normalizeTerminalKeyInput(input: TerminalKeyInput): NormalizedKeyEvent {
  if (typeof input.composing !== 'boolean') throw new TypeError('key.composing must be a boolean')
  if (typeof input.text !== 'string') throw new TypeError('key.text must be a string')
  return {
    action: nativeKeyAction(input.action),
    composing: input.composing,
    consumedModifiers: nativeModifiers(input.consumedModifiers),
    key: physicalKeyFromCode(input.code),
    modifiers: nativeModifiers(input.modifiers),
    text: input.text,
    unshiftedCodepoint: unshiftedCodepoint(input.code),
  }
}

export function normalizeTerminalMouseInput(input: TerminalMouseInput): {
  event: NormalizedMouseEvent
  state: MouseEncoderState
} {
  return {
    event: {
      action: nativeMouseAction(input.event.action),
      button: nativeMouseButton(input.event.button),
      modifiers: nativeModifiers(input.event.modifiers),
      x: input.event.x,
      y: input.event.y,
    },
    state: {
      anyButtonPressed: input.state.anyButtonPressed,
      geometry: { ...input.state.geometry },
    },
  }
}

const defaultGrid: TerminalGrid = Object.freeze({
  cellHeight: 16,
  cellWidth: 8,
  columns: 80,
  pixelRatio: 1,
  rows: 24,
})

const defaultFont: TerminalFontSettings = Object.freeze({
  boldWeight: 700,
  family: 'monospace',
  letterSpacing: 0,
  lineHeight: 1.2,
  size: 14,
  weight: 400,
})

const defaultCursor: TerminalCursorSettings = Object.freeze({
  blink: false,
  style: 'block',
})

type PendingEffect =
  | { readonly bytes: Uint8Array; readonly type: 'data' }
  | { readonly cause: unknown; readonly operation: string; readonly type: 'error' }
  | { readonly type: 'bell' }
  | { readonly type: 'title' }

type ReadyEffect =
  | Exclude<PendingEffect, { readonly type: 'title' }>
  | { readonly title: string; readonly type: 'title' }

interface EffectState {
  readonly effects: TerminalEffects
  readonly pending: PendingEffect[]
  clipboardWrite?: TerminalClipboardWritePolicy
  vtWriteActive: boolean
}

interface RuntimeLease {
  readonly owned: boolean
  readonly runtime: GhosttyRuntime
}

interface NativeResources {
  readonly key: GhosttyKeyEncoder
  readonly mouse: GhosttyMouseEncoder
  readonly renderState: GhosttyRenderState
  readonly selection: GhosttySelectionGesture
  readonly terminal: GhosttyTerminal
}

interface Osc8RangeCache {
  readonly cellCount: number
  readonly range: LinkRange
  readonly row: number
  readonly uri: string
}

interface PartialResources {
  key?: GhosttyKeyEncoder
  links?: LinkResolver<unknown>
  mouse?: GhosttyMouseEncoder
  renderState?: GhosttyRenderState
  runtime?: GhosttyRuntime
  selection?: GhosttySelectionGesture
  terminal?: GhosttyTerminal
}

type SessionEmitters = {
  -readonly [TType in TerminalSessionEventType]: EventEmitter<TerminalSessionEventMap[TType]>
}

function validatePositive(name: string, value: number, integer: boolean): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`)
  }
  if (!integer || Number.isInteger(value)) return value
  throw new RangeError(`${name} must be a positive integer`)
}

function validateColorChannel(name: string, value: number): number {
  if (Number.isInteger(value) && value >= 0 && value <= 0xff) return value
  throw new RangeError(`${name} must be an integer from 0 to 255`)
}

function validateNonNegative(name: string, value: number): number {
  if (Number.isFinite(value) && value >= 0) return value
  throw new RangeError(`${name} must be a finite non-negative number`)
}

function validateFinite(name: string, value: number): number {
  if (Number.isFinite(value)) return value
  throw new RangeError(`${name} must be finite`)
}

function validateFontWeight(name: string, value: number): number {
  if (Number.isInteger(value) && value >= 1 && value <= 1000) return value
  throw new RangeError(`${name} must be an integer from 1 to 1000`)
}

function validateLineHeight(value: number): number {
  if (Number.isFinite(value) && value >= 1) return value
  throw new RangeError('font.lineHeight must be finite and at least 1')
}

function copyColor(color: RgbColor, name: string): TerminalColor {
  return Object.freeze({
    b: validateColorChannel(`${name}.b`, color.b),
    g: validateColorChannel(`${name}.g`, color.g),
    r: validateColorChannel(`${name}.r`, color.r),
  })
}

function copyPalette(palette: readonly RgbColor[]): readonly TerminalColor[] {
  if (palette.length !== paletteLength) {
    throw new RangeError(`theme.palette must contain exactly ${paletteLength} colors`)
  }
  return Object.freeze(palette.map((color, index) => copyColor(color, `theme.palette[${index}]`)))
}

function copyRendererTheme(theme: TerminalTheme): TerminalRendererTheme {
  return Object.freeze({
    background: theme.background,
    cursor: theme.cursor,
    foreground: theme.foreground,
    minimumContrast: theme.minimumContrast,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
  })
}

function copyTheme(theme: TerminalTheme): TerminalTheme {
  const minimumContrast = validateNonNegative('theme.minimumContrast', theme.minimumContrast)
  return Object.freeze({
    background: copyColor(theme.background, 'theme.background'),
    cursor: copyColor(theme.cursor, 'theme.cursor'),
    foreground: copyColor(theme.foreground, 'theme.foreground'),
    minimumContrast,
    palette: copyPalette(theme.palette),
    selectionBackground: copyColor(theme.selectionBackground, 'theme.selectionBackground'),
    selectionForeground: copyColor(theme.selectionForeground, 'theme.selectionForeground'),
  })
}

function normalizeGrid(current: TerminalGrid, next: Partial<TerminalGrid> = {}): TerminalGrid {
  const geometry = normalizeCellGeometry({
    cellHeight: next.cellHeight ?? current.cellHeight,
    cellWidth: next.cellWidth ?? current.cellWidth,
    pixelRatio: next.pixelRatio ?? current.pixelRatio,
  })
  return Object.freeze({
    cellHeight: geometry.cellHeight,
    cellWidth: geometry.cellWidth,
    columns: validatePositive('grid.columns', next.columns ?? current.columns, true),
    pixelRatio: geometry.pixelRatio,
    rows: validatePositive('grid.rows', next.rows ?? current.rows, true),
  })
}

function nativeGrid(grid: TerminalGrid): TerminalSize {
  const geometry = normalizeCellGeometry(grid)
  return {
    cellHeight: geometry.deviceCellHeight,
    cellWidth: geometry.deviceCellWidth,
    columns: grid.columns,
    rows: grid.rows,
  }
}

function normalizeFont(
  current: TerminalFontSettings,
  next: Partial<TerminalFontSettings> = {},
): TerminalFontSettings {
  const family = next.family ?? current.family
  if (typeof family !== 'string' || family.length === 0) {
    throw new TypeError('font.family must be a non-empty string')
  }
  return Object.freeze({
    boldWeight: validateFontWeight('font.boldWeight', next.boldWeight ?? current.boldWeight),
    family: family.slice(),
    letterSpacing: validateFinite(
      'font.letterSpacing',
      next.letterSpacing ?? current.letterSpacing,
    ),
    lineHeight: validateLineHeight(next.lineHeight ?? current.lineHeight),
    size: validatePositive('font.size', next.size ?? current.size, false),
    weight: validateFontWeight('font.weight', next.weight ?? current.weight),
  })
}

function normalizeCursor(
  current: TerminalCursorSettings,
  next: Partial<TerminalCursorSettings> = {},
): TerminalCursorSettings {
  const blink = next.blink ?? current.blink
  const style = next.style ?? current.style
  if (typeof blink !== 'boolean') throw new TypeError('cursor.blink must be a boolean')
  if (style === 'bar' || style === 'block' || style === 'outline' || style === 'underline') {
    return Object.freeze({ blink, style })
  }
  throw new TypeError(`Unknown cursor style: ${String(style)}`)
}

function normalizeColorScheme(value: TerminalColorScheme): TerminalColorScheme {
  if (value === 'dark' || value === 'light') return value
  throw new TypeError(`Unknown color scheme: ${String(value)}`)
}

function createDefaultTheme(terminal: GhosttyTerminal): TerminalTheme {
  return copyTheme({ ...defaultRendererTheme, palette: terminal.defaultPalette })
}

function createAppearance(
  terminal: GhosttyTerminal,
  grid: TerminalGrid,
  options: TerminalAppearanceOptions = {},
): TerminalAppearance {
  const theme = options.theme ? copyTheme(options.theme) : createDefaultTheme(terminal)
  return freezeAppearance({
    colorScheme: normalizeColorScheme(options.colorScheme ?? 'dark'),
    cursor: normalizeCursor(defaultCursor, options.cursor),
    font: normalizeFont(defaultFont, options.font),
    grid,
    rendererTheme: copyRendererTheme(theme),
    scrollbackLimit: options.scrollbackLimit,
    theme,
  })
}

function freezeAppearance(appearance: TerminalAppearance): TerminalAppearance {
  return Object.freeze(appearance)
}

function mergeAppearance(
  current: TerminalAppearance,
  options: TerminalAppearanceOptions,
): TerminalAppearance {
  const theme = options.theme ? copyTheme(options.theme) : current.theme
  return freezeAppearance({
    colorScheme: normalizeColorScheme(options.colorScheme ?? current.colorScheme),
    cursor: normalizeCursor(current.cursor, options.cursor),
    font: normalizeFont(current.font, options.font),
    grid: normalizeGrid(current.grid, options.grid),
    rendererTheme: copyRendererTheme(theme),
    scrollbackLimit: options.scrollbackLimit ?? current.scrollbackLimit,
    theme,
  })
}

function withScrollbackLimit(
  current: TerminalAppearance,
  scrollbackLimit: number | undefined,
): TerminalAppearance {
  return freezeAppearance({ ...current, scrollbackLimit })
}

function colorsEqual(first: TerminalColor, second: TerminalColor): boolean {
  return first.r === second.r && first.g === second.g && first.b === second.b
}

function palettesEqual(first: readonly TerminalColor[], second: readonly TerminalColor[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (!colorsEqual(first[index]!, second[index]!)) return false
  }
  return true
}

function themesEqual(first: TerminalTheme, second: TerminalTheme): boolean {
  return (
    first.minimumContrast === second.minimumContrast &&
    colorsEqual(first.background, second.background) &&
    colorsEqual(first.cursor, second.cursor) &&
    colorsEqual(first.foreground, second.foreground) &&
    colorsEqual(first.selectionBackground, second.selectionBackground) &&
    colorsEqual(first.selectionForeground, second.selectionForeground) &&
    palettesEqual(first.palette, second.palette)
  )
}

function gridsEqual(first: TerminalGrid, second: TerminalGrid): boolean {
  return (
    first.cellHeight === second.cellHeight &&
    first.cellWidth === second.cellWidth &&
    first.columns === second.columns &&
    first.pixelRatio === second.pixelRatio &&
    first.rows === second.rows
  )
}

function fontsEqual(first: TerminalFontSettings, second: TerminalFontSettings): boolean {
  return (
    first.boldWeight === second.boldWeight &&
    first.family === second.family &&
    first.letterSpacing === second.letterSpacing &&
    first.lineHeight === second.lineHeight &&
    first.size === second.size &&
    first.weight === second.weight
  )
}

function cursorsEqual(first: TerminalCursorSettings, second: TerminalCursorSettings): boolean {
  return first.blink === second.blink && first.style === second.style
}

function appearancesEqual(first: TerminalAppearance, second: TerminalAppearance): boolean {
  return (
    first.colorScheme === second.colorScheme &&
    first.scrollbackLimit === second.scrollbackLimit &&
    gridsEqual(first.grid, second.grid) &&
    fontsEqual(first.font, second.font) &&
    cursorsEqual(first.cursor, second.cursor) &&
    themesEqual(first.theme, second.theme)
  )
}

function nativeColorScheme(value: TerminalColorScheme): ColorScheme {
  return value === 'dark' ? ColorScheme.Dark : ColorScheme.Light
}

function publicClipboardLocation(value: ClipboardLocation): TerminalClipboardLocation {
  if (value === ClipboardLocation.Standard) return 'standard'
  if (value === ClipboardLocation.Selection) return 'selection'
  if (value === ClipboardLocation.Primary) return 'primary'
  throw new TypeError(`Unknown clipboard location: ${value}`)
}

function nativeClipboardResult(value: TerminalClipboardWriteResult): ClipboardWriteResult {
  if (value === 'success') return ClipboardWriteResult.Success
  if (value === 'denied') return ClipboardWriteResult.Denied
  if (value === 'unsupported') return ClipboardWriteResult.Unsupported
  if (value === 'busy') return ClipboardWriteResult.Busy
  if (value === 'invalid-data') return ClipboardWriteResult.InvalidData
  if (value === 'io-error') return ClipboardWriteResult.IoError
  throw new TypeError(`Unknown clipboard write result: ${String(value)}`)
}

function copyClipboardWrite(write: ClipboardWrite): TerminalClipboardWrite {
  const contents = write.contents.map((content) =>
    Object.freeze({ data: Uint8Array.from(content.data), mime: content.mime.slice() }),
  )
  return Object.freeze({
    contents: Object.freeze(contents),
    location: publicClipboardLocation(write.location),
  })
}

function handleClipboardWrite(state: EffectState, write: ClipboardWrite): ClipboardWriteResult {
  const policy = state.clipboardWrite
  if (!policy) return ClipboardWriteResult.Denied
  try {
    return nativeClipboardResult(policy(copyClipboardWrite(write)))
  } catch (cause) {
    state.pending.push({ cause, operation: 'clipboardWrite', type: 'error' })
    return ClipboardWriteResult.IoError
  }
}

function createEffectState(
  colorScheme: TerminalColorScheme,
  clipboardWrite?: TerminalClipboardWritePolicy,
): EffectState {
  const state = {
    clipboardWrite,
    effects: {} as TerminalEffects,
    pending: [] as PendingEffect[],
    vtWriteActive: false,
  }
  state.effects.bell = () => state.pending.push({ type: 'bell' })
  state.effects.clipboardWrite = (write) => handleClipboardWrite(state, write)
  state.effects.colorScheme = nativeColorScheme(colorScheme)
  state.effects.titleChanged = () => state.pending.push({ type: 'title' })
  state.effects.writePty = (bytes) => {
    state.pending.push({ bytes: Uint8Array.from(bytes), type: 'data' })
  }
  return state
}

function createEventSink(
  errors: EventEmitter<TerminalErrorEvent>,
  operation: string,
): (cause: unknown) => void {
  return (cause) => errors.emit({ cause, operation })
}

function createEmitters(): SessionEmitters {
  const error = new EventEmitter<TerminalErrorEvent>()
  return {
    appearance: new EventEmitter(createEventSink(error, 'event.appearance')),
    bell: new EventEmitter(createEventSink(error, 'event.bell')),
    data: new EventEmitter(createEventSink(error, 'event.data')),
    error,
    renderRequest: new EventEmitter(createEventSink(error, 'event.renderRequest')),
    resize: new EventEmitter(createEventSink(error, 'event.resize')),
    scroll: new EventEmitter(createEventSink(error, 'event.scroll')),
    selection: new EventEmitter(createEventSink(error, 'event.selection')),
    title: new EventEmitter(createEventSink(error, 'event.title')),
  }
}

function disposeEmitters(emitters: SessionEmitters): void {
  emitters.appearance.dispose()
  emitters.bell.dispose()
  emitters.data.dispose()
  emitters.renderRequest.dispose()
  emitters.resize.dispose()
  emitters.scroll.dispose()
  emitters.selection.dispose()
  emitters.title.dispose()
  emitters.error.dispose()
}

async function acquireRuntime(source?: TerminalSessionRuntime): Promise<RuntimeLease> {
  if (source?.kind === 'borrowed') {
    source.runtime.ensureActive()
    return { owned: false, runtime: source.runtime }
  }
  if (!source || source.kind === 'owned') {
    return { owned: true, runtime: await GhosttyRuntime.create(source?.options) }
  }
  throw new TypeError(
    `Unknown terminal runtime source: ${String((source as { kind?: unknown }).kind)}`,
  )
}

function ignoreDisposal(dispose: (() => void) | undefined): void {
  if (!dispose) return
  try {
    dispose()
  } catch {
    return
  }
}

function disposePartial(resources: PartialResources, ownedRuntime: boolean): void {
  ignoreDisposal(resources.links ? () => resources.links?.dispose() : undefined)
  ignoreDisposal(resources.selection ? () => resources.selection?.dispose() : undefined)
  ignoreDisposal(resources.mouse ? () => resources.mouse?.dispose() : undefined)
  ignoreDisposal(resources.key ? () => resources.key?.dispose() : undefined)
  ignoreDisposal(resources.renderState ? () => resources.renderState?.dispose() : undefined)
  ignoreDisposal(resources.terminal ? () => resources.terminal?.dispose() : undefined)
  if (ownedRuntime)
    ignoreDisposal(resources.runtime ? () => resources.runtime?.dispose() : undefined)
}

function applyTheme(terminal: GhosttyTerminal, theme: TerminalTheme): void {
  terminal.setDefaultForegroundColor(theme.foreground)
  terminal.setDefaultBackgroundColor(theme.background)
  terminal.setDefaultCursorColor(theme.cursor)
  terminal.setDefaultPalette(theme.palette)
}

function applyInitialAppearance(terminal: GhosttyTerminal, appearance: TerminalAppearance): void {
  applyTheme(terminal, appearance.theme)
  terminal.setDefaultCursorStyle(appearance.cursor.style)
  terminal.setDefaultCursorBlink(appearance.cursor.blink)
  terminal.setScrollbackLimit(appearance.scrollbackLimit)
}

function readScrollSnapshot(terminal: GhosttyTerminal): TerminalScrollEvent {
  return Object.freeze({
    scrollbackLength: terminal.scrollbackLength,
    scrollbar: Object.freeze({ ...terminal.scrollbar }),
    viewportActive: terminal.viewportActive,
  })
}

function scrollSnapshotsEqual(first: TerminalScrollEvent, second: TerminalScrollEvent): boolean {
  return (
    first.scrollbackLength === second.scrollbackLength &&
    first.viewportActive === second.viewportActive &&
    first.scrollbar.length === second.scrollbar.length &&
    first.scrollbar.offset === second.scrollbar.offset &&
    first.scrollbar.total === second.scrollbar.total
  )
}

function copyInput(data: TerminalInputData): Uint8Array {
  if (typeof data === 'string') return encoder.encode(data)
  return Uint8Array.from(data)
}

function appendLineEnding(data: TerminalInputData): TerminalInputData {
  if (typeof data === 'string') return `${data}\r\n`
  const result = new Uint8Array(data.length + 2)
  result.set(data)
  result.set([0x0d, 0x0a], data.length)
  return result
}

function coalesceTitleEffects(effects: readonly PendingEffect[]): readonly PendingEffect[] {
  let lastTitle = -1
  for (let index = 0; index < effects.length; index += 1) {
    if (effects[index]!.type === 'title') lastTitle = index
  }
  if (lastTitle < 0) return effects
  return effects.filter((effect, index) => effect.type !== 'title' || index === lastTitle)
}

function reportLinkError<TEvent>(
  emitters: SessionEmitters,
  configured: LinkResolverOptions<TEvent>['onError'],
  error: LinkResolverError,
): void {
  emitters.error.emit({ cause: error.cause, operation: `link.${error.operation}` })
  if (!configured) return
  try {
    const result = configured(error)
    void Promise.resolve(result).catch((cause: unknown) => {
      emitters.error.emit({ cause, operation: 'link.onError' })
    })
  } catch (cause) {
    emitters.error.emit({ cause, operation: 'link.onError' })
  }
}

function createLinkResolver<TEvent>(
  options: LinkResolverOptions<TEvent> | undefined,
  emitters: SessionEmitters,
): LinkResolver<TEvent> {
  return new LinkResolver({
    activateUri: options?.activateUri,
    onError: (error) => reportLinkError(emitters, options?.onError, error),
  })
}

export interface TerminalSessionSendInputOptions {
  readonly preserveSelection?: boolean
}

export interface TerminalSessionPasteOptions {
  readonly bracketed?: boolean
}

export interface TerminalSessionKeyOptions {
  readonly onEncoded?: (data: Uint8Array) => void
}

export class TerminalSession<TEvent = unknown> {
  private activeOperations = 0
  private appearanceValue: TerminalAppearance
  private disposalRequested = false
  private disposed = false
  private readonly effectState: EffectState
  private readonly emitters: SessionEmitters
  private focusedValue = false
  private readonly keyEncoder: GhosttyKeyEncoder
  private readonly links: LinkResolver<TEvent>
  private readonly mouseEncoder: GhosttyMouseEncoder
  private readonly nativeRenderState: GhosttyRenderState
  private osc8RangeCache?: Osc8RangeCache
  private readonly ownsRuntime: boolean
  private revisionValue = 0
  private readonly runtimeValue: GhosttyRuntime
  private readonly selection: GhosttySelectionGesture
  private scrollValue: TerminalScrollEvent
  private readonly terminal: GhosttyTerminal

  private constructor(
    lease: RuntimeLease,
    resources: NativeResources,
    appearance: TerminalAppearance,
    effectState: EffectState,
    emitters: SessionEmitters,
    links: LinkResolver<TEvent>,
  ) {
    this.runtimeValue = lease.runtime
    this.ownsRuntime = lease.owned
    this.terminal = resources.terminal
    this.nativeRenderState = resources.renderState
    this.keyEncoder = resources.key
    this.mouseEncoder = resources.mouse
    this.selection = resources.selection
    this.appearanceValue = appearance
    this.effectState = effectState
    this.emitters = emitters
    this.links = links
    this.scrollValue = readScrollSnapshot(resources.terminal)
  }

  static async create<TEvent = unknown>(
    options: TerminalSessionOptions<TEvent> = {},
  ): Promise<TerminalSession<TEvent>> {
    const emitters = createEmitters()
    const partial: PartialResources = {}
    let ownedRuntime = false
    try {
      const lease = await acquireRuntime(options.runtime)
      partial.runtime = lease.runtime
      ownedRuntime = lease.owned
      const grid = normalizeGrid(defaultGrid, options.appearance?.grid)
      const colorScheme = normalizeColorScheme(options.appearance?.colorScheme ?? 'dark')
      const effectState = createEffectState(colorScheme, options.clipboardWrite)
      const terminal = lease.runtime.createTerminal({
        ...nativeGrid(grid),
        effects: effectState.effects,
      })
      partial.terminal = terminal
      const appearance = createAppearance(terminal, grid, options.appearance)
      applyInitialAppearance(terminal, appearance)
      const renderState = lease.runtime.createRenderState(terminal)
      partial.renderState = renderState
      const key = new GhosttyKeyEncoder(terminal)
      partial.key = key
      const mouse = new GhosttyMouseEncoder(terminal)
      partial.mouse = mouse
      const selection = new GhosttySelectionGesture(terminal)
      partial.selection = selection
      const links = createLinkResolver(options.links, emitters)
      partial.links = links as LinkResolver<unknown>
      effectState.pending.length = 0
      return new TerminalSession(
        lease,
        { key, mouse, renderState, selection, terminal },
        appearance,
        effectState,
        emitters,
        links,
      )
    } catch (cause) {
      disposePartial(partial, ownedRuntime)
      disposeEmitters(emitters)
      throw cause
    }
  }

  get appearance(): TerminalAppearance {
    this.ensureActive()
    return this.appearanceValue
  }

  get runtime(): GhosttyRuntime {
    this.ensureActive()
    return this.runtimeValue
  }

  get cursor(): TerminalCursorSnapshot {
    this.ensureActive()
    return Object.freeze({ ...this.terminal.cursor })
  }

  get focused(): boolean {
    this.ensureActive()
    return this.focusedValue
  }

  get focusReportingEnabled(): boolean {
    this.ensureActive()
    return this.terminal.isModeEnabled(TerminalMode.FocusEvent)
  }

  get grid(): TerminalGrid {
    this.ensureActive()
    return this.appearanceValue.grid
  }

  get mouseTracking(): boolean {
    this.ensureActive()
    return this.terminal.mouseTracking
  }

  get renderState(): RenderStateSource {
    this.ensureActive()
    return this.nativeRenderState
  }

  get revision(): number {
    this.ensureActive()
    return this.revisionValue
  }

  get scrollbackLength(): number {
    this.ensureActive()
    return this.scrollValue.scrollbackLength
  }

  get scrollbar(): Readonly<TerminalScrollbar> {
    this.ensureActive()
    return this.scrollValue.scrollbar
  }

  get viewportActive(): boolean {
    this.ensureActive()
    return this.scrollValue.viewportActive
  }

  on<TType extends TerminalSessionEventType>(
    type: TType,
    listener: TerminalSessionListener<TType>,
  ): TerminalSessionSubscription {
    this.ensureActive()
    const emitter = this.emitters[type] as EventEmitter<TerminalSessionEventMap[TType]>
    return emitter.subscribe(listener)
  }

  write(data: TerminalInputData): TerminalMutationResult {
    return this.runOperation(() => this.writeNow(data))
  }

  writeln(data: TerminalInputData): TerminalMutationResult {
    return this.write(appendLineEnding(data))
  }

  sendInput(
    data: TerminalInputData,
    options: TerminalSessionSendInputOptions = {},
  ): TerminalInputResult {
    return this.runOperation(() =>
      this.publishInput(copyInput(data), options.preserveSelection !== true),
    )
  }

  key(input: TerminalKeyInput, options: TerminalSessionKeyOptions = {}): TerminalInputResult {
    return this.runOperation(() => {
      const event = normalizeTerminalKeyInput(input)
      const bytes = this.keyEncoder.encode(event)
      if (bytes.length > 0) options.onEncoded?.(Uint8Array.from(bytes))
      return this.publishInput(bytes, true)
    })
  }

  mouse(input: TerminalMouseInput): TerminalInputResult {
    return this.runOperation(() => {
      const normalized = normalizeTerminalMouseInput(input)
      return this.publishInput(this.mouseEncoder.encode(normalized.event, normalized.state), false)
    })
  }

  resetMouseTracking(): void {
    this.runOperation(() => this.mouseEncoder.reset())
  }

  paste(data: TerminalInputData, options: TerminalSessionPasteOptions = {}): TerminalInputResult {
    return this.runOperation(() =>
      this.publishInput(encodePaste(this.terminal, data, { bracketed: options.bracketed }), true),
    )
  }

  isPasteSafe(data: TerminalInputData): boolean {
    this.ensureActive()
    return isPasteSafe(this.runtimeValue, data)
  }

  setFocused(focused: boolean): TerminalInputResult {
    return this.runOperation(() => this.setFocusedNow(focused))
  }

  reportFocus(): TerminalInputResult {
    return this.runOperation(() =>
      this.publishInput(encodeFocus(this.terminal, this.focusedValue), false),
    )
  }

  clear(): TerminalMutationResult {
    return this.runOperation(() => this.clearNow())
  }

  reset(): TerminalMutationResult {
    return this.runOperation(() => this.resetNow())
  }

  setAppearance(options: TerminalAppearanceOptions): TerminalMutationResult {
    return this.runOperation(() =>
      this.commitAppearance(mergeAppearance(this.appearanceValue, options)),
    )
  }

  resize(grid: Partial<TerminalGrid>): TerminalMutationResult {
    return this.runOperation(() => {
      const nextGrid = normalizeGrid(this.appearanceValue.grid, grid)
      return this.commitAppearance(freezeAppearance({ ...this.appearanceValue, grid: nextGrid }))
    })
  }

  setFont(font: Partial<TerminalFontSettings>): TerminalMutationResult {
    return this.setAppearance({ font })
  }

  setCursor(cursor: Partial<TerminalCursorSettings>): TerminalMutationResult {
    return this.setAppearance({ cursor })
  }

  setColorScheme(colorScheme: TerminalColorScheme): TerminalMutationResult {
    return this.setAppearance({ colorScheme })
  }

  setTheme(theme: TerminalTheme): TerminalMutationResult {
    return this.setAppearance({ theme })
  }

  setScrollbackLimit(scrollbackLimit?: number): TerminalMutationResult {
    return this.runOperation(() =>
      this.commitAppearance(withScrollbackLimit(this.appearanceValue, scrollbackLimit)),
    )
  }

  setClipboardWritePolicy(policy?: TerminalClipboardWritePolicy): void {
    this.ensureActive()
    if (policy !== undefined && typeof policy !== 'function') {
      throw new TypeError('clipboard write policy must be a function')
    }
    this.effectState.clipboardWrite = policy
  }

  scrollToTop(): TerminalMutationResult {
    return this.runOperation(() => this.scroll(() => this.terminal.scrollToTop()))
  }

  scrollToBottom(): TerminalMutationResult {
    return this.runOperation(() => this.scroll(() => this.terminal.scrollToBottom()))
  }

  scrollBy(delta: number): TerminalMutationResult {
    return this.runOperation(() => this.scroll(() => this.terminal.scrollBy(delta)))
  }

  scrollToRow(row: number): TerminalMutationResult {
    return this.runOperation(() => this.scroll(() => this.terminal.scrollToRow(row)))
  }

  selectionPress(input: TerminalSelectionPressInput): SelectionGestureUpdate {
    return this.runOperation(() => {
      const update = this.selection.press(input)
      this.publishSelectionUpdate(update)
      return update
    })
  }

  selectionDrag(input: TerminalSelectionDragInput): SelectionGestureUpdate {
    return this.runOperation(() => {
      const update = this.selection.drag(input)
      this.publishSelectionUpdate(update)
      return update
    })
  }

  selectionAutoscrollTick(input: TerminalSelectionDragInput): SelectionGestureUpdate {
    return this.runOperation(() => this.selectionAutoscrollTickNow(input))
  }

  selectionRelease(input?: TerminalSelectionReleaseInput): SelectionGestureRelease {
    this.ensureActive()
    return this.selection.release(input)
  }

  resetSelectionGesture(): void {
    this.runOperation(() => this.selection.reset())
  }

  cancelSelection(): boolean {
    return this.runOperation(() => {
      this.selection.reset()
      return this.clearSelectionNow()
    })
  }

  clearSelection(): boolean {
    return this.runOperation(() => this.clearSelectionNow())
  }

  selectAll(): SelectionGestureUpdate {
    return this.runOperation(() => {
      const update = this.selection.selectAll()
      this.publishSelectionUpdate(update)
      return update
    })
  }

  selectRange(start: SelectionPoint, end: SelectionPoint): SelectionGestureUpdate {
    return this.runOperation(() => {
      const update = this.selection.selectRange(start, end)
      this.publishSelectionUpdate(update)
      return update
    })
  }

  selectLines(startRow: number, endRow: number): SelectionGestureUpdate {
    return this.runOperation(() => {
      const update = this.selection.selectLines(startRow, endRow)
      this.publishSelectionUpdate(update)
      return update
    })
  }

  setSelectionWordBoundaryCodepoints(value: string): boolean {
    return this.runOperation(() => this.selection.setWordBoundaryCodepoints(value))
  }

  getSelection(options: TerminalSelectionFormatOptions = {}): string | undefined {
    this.ensureActive()
    return this.selection.getSelection(options)
  }

  selectionCoordinates(): SelectionCoordinates | undefined {
    this.ensureActive()
    return this.selection.coordinates()
  }

  registerLinkProvider(provider: LinkProvider<TEvent>): LinkProviderRegistration {
    this.ensureActive()
    return this.links.registerProvider(provider)
  }

  resolveLink(request: TerminalLinkRequest): Promise<LinkResolution<TEvent>> {
    return this.runOperation(() => {
      const osc8Uri = this.selection.linkAt({ x: request.column, y: request.row })
      const osc8Range = osc8Uri ? this.osc8Range(request, osc8Uri) : undefined
      return this.links.resolve({ ...request, osc8Range, osc8Uri })
    })
  }

  private osc8Range(request: TerminalLinkRequest, uri: string): LinkRange {
    const cached = this.osc8RangeCache
    if (
      cached &&
      cached.cellCount === request.line.length &&
      cached.row === request.row &&
      cached.uri === uri &&
      request.column >= cached.range.start &&
      request.column <= cached.range.end
    ) {
      return cached.range
    }

    let start = request.column
    while (start > 0) {
      const adjacent = this.selection.linkAt({ x: start - 1, y: request.row })
      if (adjacent !== uri) break
      start -= 1
    }
    let end = request.column
    while (end + 1 < request.line.length) {
      const adjacent = this.selection.linkAt({ x: end + 1, y: request.row })
      if (adjacent !== uri) break
      end += 1
    }
    const range = Object.freeze({ end, start })
    this.osc8RangeCache = Object.freeze({
      cellCount: request.line.length,
      range,
      row: request.row,
      uri,
    })
    return range
  }

  isLinkCurrent(resolution: LinkResolution<TEvent>): boolean {
    this.ensureActive()
    return this.links.isCurrent(resolution)
  }

  activateLink(resolution: LinkResolution<TEvent>, event: TEvent): Promise<boolean> {
    return this.runOperation(() => this.links.activate(resolution, event))
  }

  dispose(): void {
    if (this.disposed || this.disposalRequested) return
    this.disposalRequested = true
    if (this.activeOperations > 0) return
    this.finalizeDispose()
  }

  private finalizeDispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeResource('links.dispose', () => this.links.dispose())
    this.disposeResource('selection.dispose', () => this.selection.dispose())
    this.disposeResource('mouse.dispose', () => this.mouseEncoder.dispose())
    this.disposeResource('key.dispose', () => this.keyEncoder.dispose())
    this.disposeResource('renderState.dispose', () => this.nativeRenderState.dispose())
    this.disposeResource('terminal.dispose', () => this.terminal.dispose())
    if (this.ownsRuntime) this.disposeResource('runtime.dispose', () => this.runtimeValue.dispose())
    this.effectState.pending.length = 0
    this.effectState.clipboardWrite = undefined
    this.osc8RangeCache = undefined
    disposeEmitters(this.emitters)
  }

  private invalidateLinks(): void {
    this.osc8RangeCache = undefined
    this.links.invalidate()
  }

  private writeNow(data: TerminalInputData): TerminalMutationResult {
    this.runVtWrite(() => this.terminal.write(data))
    this.mouseEncoder.syncFromTerminal()
    this.invalidateLinks()
    this.flushEffects()
    this.emitScrollChange()
    return this.requestRender()
  }

  private runVtWrite(write: () => void): void {
    this.effectState.vtWriteActive = true
    try {
      write()
    } catch (cause) {
      this.effectState.pending.length = 0
      throw cause
    } finally {
      this.effectState.vtWriteActive = false
    }
  }

  private setFocusedNow(focused: boolean): TerminalInputResult {
    if (typeof focused !== 'boolean') throw new TypeError('focused must be a boolean')
    if (focused === this.focusedValue) return new Uint8Array()
    const bytes = encodeFocus(this.terminal, focused)
    this.focusedValue = focused
    return this.publishInput(bytes, false)
  }

  private clearNow(): TerminalMutationResult {
    const hadSelection = this.selection.hasSelection
    const forceScroll = this.scrollValue.scrollbackLength > 0 || this.terminal.cursor.y > 0
    this.runVtWrite(() => this.terminal.clear())
    this.selection.reset()
    this.invalidateLinks()
    this.flushEffects()
    if (hadSelection) this.emitSelection()
    this.emitScrollChange(forceScroll)
    return this.requestRender()
  }

  private resetNow(): TerminalMutationResult {
    const hadSelection = this.selection.hasSelection
    this.terminal.reset()
    this.selection.reset()
    this.selection.clear()
    this.mouseEncoder.reset()
    this.mouseEncoder.syncFromTerminal()
    this.invalidateLinks()
    this.flushEffects()
    if (hadSelection) this.emitSelection()
    this.emitScrollChange()
    return this.requestRender()
  }

  private selectionAutoscrollTickNow(input: TerminalSelectionDragInput): SelectionGestureUpdate {
    const update = this.selection.autoscrollTick(input)
    this.invalidateLinks()
    const scrollChanged = this.emitScrollChange()
    if (update.selectionChanged) this.emitSelection()
    if (update.selectionChanged || scrollChanged) this.requestRender()
    return update
  }

  private clearSelectionNow(): boolean {
    const changed = this.selection.clear()
    if (!changed) return false
    this.emitSelection()
    this.requestRender()
    return true
  }

  private commitAppearance(next: TerminalAppearance): TerminalMutationResult {
    const current = this.appearanceValue
    if (appearancesEqual(current, next)) return this.mutationResult()
    const gridChanged = !gridsEqual(current.grid, next.grid)
    const cursorChanged = !cursorsEqual(current.cursor, next.cursor)
    const themeChanged = !themesEqual(current.theme, next.theme)
    const scrollbackChanged = current.scrollbackLimit !== next.scrollbackLimit
    const colorSchemeChanged = current.colorScheme !== next.colorScheme

    if (themeChanged) applyTheme(this.terminal, next.theme)
    if (cursorChanged) this.applyCursor(next.cursor)
    if (scrollbackChanged) this.terminal.setScrollbackLimit(next.scrollbackLimit)
    if (gridChanged) this.terminal.resize(nativeGrid(next.grid))
    if (colorSchemeChanged)
      this.effectState.effects.colorScheme = nativeColorScheme(next.colorScheme)

    this.appearanceValue = next
    if (gridChanged || scrollbackChanged) this.invalidateLinks()
    if (gridChanged) this.emitters.resize.emit({ grid: next.grid })
    if (gridChanged || scrollbackChanged) this.emitScrollChange()
    this.emitters.appearance.emit({ appearance: next })
    return this.requestRender()
  }

  private applyCursor(cursor: TerminalCursorSettings): void {
    this.terminal.setDefaultCursorStyle(cursor.style)
    this.terminal.setDefaultCursorBlink(cursor.blink)
  }

  private scroll(action: () => void): TerminalMutationResult {
    action()
    this.invalidateLinks()
    if (!this.emitScrollChange()) return this.mutationResult()
    return this.requestRender()
  }

  private publishInput(bytes: Uint8Array, clearSelection: boolean): TerminalInputResult {
    const result = Uint8Array.from(bytes)
    if (result.length === 0) return result
    const selectionChanged = clearSelection && this.selection.clear()
    if (selectionChanged) {
      this.emitSelection()
      this.requestRender()
    }
    const event: TerminalDataEvent = { bytes: Uint8Array.from(result) }
    this.emitters.data.emit(event)
    return result
  }

  private publishSelectionUpdate(update: SelectionGestureUpdate): void {
    if (!update.selectionChanged) return
    this.emitSelection()
    this.requestRender()
  }

  private emitSelection(): void {
    const hasSelection = this.selection.hasSelection
    const coordinates = this.selection.coordinates()
    this.emitters.selection.emit({
      coordinates,
      hasSelection,
    })
  }

  private emitScrollChange(force = false): boolean {
    const next = readScrollSnapshot(this.terminal)
    if (!force && scrollSnapshotsEqual(this.scrollValue, next)) return false
    this.scrollValue = next
    this.emitters.scroll.emit(next)
    return true
  }

  private flushEffects(): void {
    const effects = this.effectState.pending.splice(0)
    const coalesced = coalesceTitleEffects(effects)
    const ready = coalesced.map((effect) => this.materializeEffect(effect))
    for (const effect of ready) this.flushEffect(effect)
  }

  private materializeEffect(effect: PendingEffect): ReadyEffect {
    if (effect.type !== 'title') return effect
    try {
      return { title: this.terminal.title.slice(), type: 'title' }
    } catch (cause) {
      return { cause, operation: 'title.read', type: 'error' }
    }
  }

  private flushEffect(effect: ReadyEffect): void {
    if (effect.type === 'data') {
      this.emitters.data.emit({ bytes: effect.bytes })
      return
    }
    if (effect.type === 'bell') {
      this.emitters.bell.emit()
      return
    }
    if (effect.type === 'error') {
      this.emitters.error.emit({ cause: effect.cause, operation: effect.operation })
      return
    }
    this.emitters.title.emit({ title: effect.title })
  }

  private requestRender(): TerminalMutationResult {
    this.revisionValue += 1
    const result = this.mutationResult()
    this.emitters.renderRequest.emit({ ...result, state: this.nativeRenderState })
    return result
  }

  private mutationResult(): TerminalMutationResult {
    return Object.freeze({ revision: this.revisionValue })
  }

  private runOperation<T>(operation: () => T): T {
    this.ensureActive()
    this.activeOperations += 1
    try {
      return operation()
    } finally {
      this.activeOperations -= 1
      if (this.activeOperations === 0 && this.disposalRequested) this.finalizeDispose()
    }
  }

  private disposeResource(operation: string, dispose: () => void): void {
    try {
      dispose()
    } catch (cause) {
      this.emitters.error.emit({ cause, operation })
    }
  }

  private ensureActive(): void {
    if (this.effectState.vtWriteActive) {
      throw createGhosttyError(
        'terminal_session.reentry',
        'Terminal session operations cannot run during a terminal VT write',
      )
    }
    if (!this.disposed && !this.disposalRequested) return
    throw createGhosttyError('terminal_session', 'The terminal session has been disposed')
  }
}
