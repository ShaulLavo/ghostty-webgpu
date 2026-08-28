import { isSupportedTerminalKeyCode, type TerminalSession } from '../term/session.js'
import type {
  TerminalInputData,
  TerminalInputResult,
  TerminalKeyAction,
  TerminalKeyInput,
  TerminalModifierSide,
  TerminalModifiers,
} from '../term/types.js'
import {
  compileHotkey,
  compileTerminalHotkeyBindings,
  hotkeyPlatformForWindow,
  type CompiledDomHotkey,
  type CompiledTerminalHotkeyBindings,
  type DomHotkeyPlatform,
} from './hotkeys.js'
import type {
  GhosttyWebGpuTerminalCopy,
  GhosttyWebGpuTerminalInputHooks,
  TerminalHotkeyBinding,
  TerminalHotkeyContext,
  TerminalHotkeyDecision,
} from './types.js'

type InputSession = Pick<
  TerminalSession<unknown>,
  'getSelection' | 'key' | 'paste' | 'selectionCoordinates' | 'sendInput'
>

type LifecycleSession = Pick<TerminalSession<unknown>, 'setFocused'>

export interface DomInputControllerOptions {
  readonly copySelection?: GhosttyWebGpuTerminalCopy
  readonly hooks?: GhosttyWebGpuTerminalInputHooks
  readonly onError: (cause: unknown, operation: string) => void
  readonly onPreedit?: (value: string) => void
  readonly platform?: DomHotkeyPlatform
  readonly session: InputSession
  readonly shortcuts?: false | readonly TerminalHotkeyBinding[]
  readonly signal: AbortSignal
  readonly textarea: HTMLTextAreaElement
}

export interface DomInputController {
  dispose(): void
  resetTransientState(): void
}

export interface DomInputLifecycleControllerOptions {
  readonly onDocumentVisible?: (visible: boolean) => void
  readonly onError: (cause: unknown, operation: string) => void
  readonly onFocused?: (focused: boolean) => void
  readonly onResetTransientState?: () => void
  readonly session: LifecycleSession
  readonly signal: AbortSignal
  readonly textarea: HTMLTextAreaElement
}

export interface DomInputLifecycleController {
  dispose(): void
}

type ModifierName = 'alt' | 'control' | 'shift' | 'super'
type ModifierState = 'Alt' | 'Control' | 'Meta' | 'Shift'

interface ModifierDefinition {
  readonly left: string
  readonly name: ModifierName
  readonly right: string
  readonly state: ModifierState
}

interface SuppressedShortcutPolicy {
  readonly preventDefault: boolean
  readonly stopPropagation: boolean
}

const modifierDefinitions: readonly ModifierDefinition[] = Object.freeze([
  { left: 'AltLeft', name: 'alt', right: 'AltRight', state: 'Alt' },
  { left: 'ControlLeft', name: 'control', right: 'ControlRight', state: 'Control' },
  { left: 'ShiftLeft', name: 'shift', right: 'ShiftRight', state: 'Shift' },
  { left: 'MetaLeft', name: 'super', right: 'MetaRight', state: 'Meta' },
])

const numLockTextCodes = new Set([
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
  'NumpadComma',
  'NumpadDecimal',
])

const c0Maximum = 0x1f
const deleteCodepoint = 0x7f
const macosFunctionKeyMinimum = 0xf700
const macosFunctionKeyMaximum = 0xf8ff

function modifierDefinition(code: string): ModifierDefinition | undefined {
  return modifierDefinitions.find(
    (definition) => code === definition.left || code === definition.right,
  )
}

function modifierSide(
  event: KeyboardEvent,
  pressedCodes: ReadonlySet<string>,
  definition: ModifierDefinition,
): TerminalModifierSide | undefined {
  if (!event.getModifierState(definition.state)) return undefined
  const left = pressedCodes.has(definition.left)
  const right = pressedCodes.has(definition.right)
  if (left !== right) return left ? 'left' : 'right'
  return 'unknown'
}

function activeModifiers(
  event: KeyboardEvent,
  pressedCodes: ReadonlySet<string>,
): TerminalModifiers {
  const result: {
    alt?: TerminalModifierSide
    capsLock?: boolean
    control?: TerminalModifierSide
    numLock?: boolean
    shift?: TerminalModifierSide
    super?: TerminalModifierSide
  } = {
    capsLock: event.getModifierState('CapsLock'),
    numLock: event.getModifierState('NumLock'),
  }
  for (const definition of modifierDefinitions) {
    const side = modifierSide(event, pressedCodes, definition)
    if (side === undefined) continue
    result[definition.name] = side
  }
  return result
}

function isUnicodeScalar(value: string): boolean {
  const characters = Array.from(value)
  if (characters.length !== 1) return false
  const codepoint = characters[0]!.codePointAt(0)!
  if (codepoint >= 0xd800 && codepoint <= 0xdfff) return false
  if (codepoint <= c0Maximum || codepoint === deleteCodepoint) return false
  return codepoint < macosFunctionKeyMinimum || codepoint > macosFunctionKeyMaximum
}

function browserKeyText(event: KeyboardEvent, composing: boolean): string {
  if (composing || !isUnicodeScalar(event.key)) return ''
  return event.key
}

function isComposingKey(event: KeyboardEvent, locallyComposing: boolean): boolean {
  if (locallyComposing || event.isComposing) return true
  if (event.key === 'Dead' || event.key === 'Process') return true
  return event.keyCode === 229
}

function keyAction(event: KeyboardEvent): TerminalKeyAction {
  if (event.type === 'keyup') return 'release'
  if (event.repeat) return 'repeat'
  return 'press'
}

function consumedModifiers(
  event: KeyboardEvent,
  modifiers: TerminalModifiers,
  text: string,
  isApplePlatform: boolean,
): TerminalModifiers | undefined {
  if (text.length === 0) return undefined
  const result: {
    alt?: TerminalModifierSide
    capsLock?: boolean
    control?: TerminalModifierSide
    numLock?: boolean
    shift?: TerminalModifierSide
  } = {}
  if (modifiers.shift) result.shift = modifiers.shift
  if (modifiers.capsLock && /^Key[A-Z]$/.test(event.code)) result.capsLock = true
  if (modifiers.numLock && numLockTextCodes.has(event.code)) result.numLock = true
  if (event.getModifierState('AltGraph')) {
    if (modifiers.control) result.control = modifiers.control
    if (modifiers.alt) result.alt = modifiers.alt
  }
  if (isApplePlatform && modifiers.alt) result.alt = modifiers.alt
  if (Object.keys(result).length === 0) return undefined
  return result
}

function normalizedKeyInput(
  event: KeyboardEvent,
  pressedCodes: ReadonlySet<string>,
  locallyComposing: boolean,
  isApplePlatform: boolean,
  macOptionIsMeta: boolean,
): TerminalKeyInput {
  const optionActsAsMeta = isApplePlatform && macOptionIsMeta && event.altKey
  const composing = !optionActsAsMeta && isComposingKey(event, locallyComposing)
  const modifiers = activeModifiers(event, pressedCodes)
  const text = browserKeyText(event, composing)
  return {
    action: keyAction(event),
    code: event.code,
    composing,
    consumedModifiers: consumedModifiers(
      event,
      modifiers,
      text,
      isApplePlatform && !macOptionIsMeta,
    ),
    modifiers,
    text,
  }
}

function isPasteInput(inputType: string): boolean {
  return inputType === 'insertFromPaste' || inputType === 'insertFromDrop'
}

function reportPromiseRejection(
  result: PromiseLike<void> | void,
  onError: (cause: unknown, operation: string) => void,
): void {
  if (!result || typeof result.then !== 'function') return
  void Promise.resolve(result).catch((cause: unknown) => onError(cause, 'copy'))
}

function inputWindow(textarea: HTMLTextAreaElement): Window {
  const view = textarea.ownerDocument.defaultView
  if (view) return view
  throw new TypeError('Terminal input requires a textarea owned by a window')
}

function defaultCopyDecision(
  context: TerminalHotkeyContext,
  copy: GhosttyWebGpuTerminalCopy | undefined,
  onError: DomInputControllerOptions['onError'],
): TerminalHotkeyDecision {
  if (!copy || !context.hasSelection()) return 'passthrough'
  const text = context.getSelection()
  if (text === undefined) return 'passthrough'
  reportPromiseRejection(copy(text), onError)
  return 'claim'
}

function defaultShortcutBindings(
  options: DomInputControllerOptions,
  platform: DomHotkeyPlatform,
): readonly TerminalHotkeyBinding[] {
  if (options.shortcuts === false) return []
  if (options.shortcuts) return options.shortcuts
  if (platform !== 'mac') return []
  return Object.freeze([
    Object.freeze({
      hotkey: 'Mod+C',
      id: 'copy-selection',
      onTrigger: (context: TerminalHotkeyContext) =>
        defaultCopyDecision(context, options.copySelection, options.onError),
      stopPropagation: false,
    }),
  ])
}

function applyShortcutPolicy(event: KeyboardEvent, policy: SuppressedShortcutPolicy): void {
  if (policy.preventDefault) event.preventDefault()
  if (policy.stopPropagation) event.stopPropagation()
}

const pastePressPolicy = Object.freeze({ preventDefault: false, stopPropagation: false })
const pasteRepeatPolicy = Object.freeze({ preventDefault: true, stopPropagation: false })
const refusedKeyPolicy = Object.freeze({ preventDefault: false, stopPropagation: false })

class BrowserInputController implements DomInputController {
  private readonly abortController = new AbortController()
  private committedDuringComposition = false
  private composing = false
  private compositionValue = ''
  private readonly composingKeyPresses = new Set<string>()
  private readonly deferredMacCommandPresses = new Map<string, KeyboardEvent>()
  private disposed = false
  private readonly forwardedMacCommandPresses = new Set<string>()
  private readonly hotkeys: CompiledTerminalHotkeyBindings
  private readonly pasteShortcut: CompiledDomHotkey
  private readonly platform: DomHotkeyPlatform
  private readonly publishedKeyPresses = new Set<string>()
  private readonly pressedModifierCodes = new Set<string>()
  private readonly suppressedShortcuts = new Map<string, SuppressedShortcutPolicy>()

  constructor(private readonly options: DomInputControllerOptions) {
    this.platform = options.platform ?? hotkeyPlatformForWindow(inputWindow(options.textarea))
    this.pasteShortcut = compileHotkey('Mod+V', this.platform)
    this.hotkeys = compileTerminalHotkeyBindings(defaultShortcutBindings(options, this.platform), {
      onError: options.onError,
      platform: this.platform,
    })
    try {
      this.installListeners()
    } catch (cause) {
      this.disposed = true
      this.abortController.abort()
      throw cause
    }
  }

  private installListeners(): void {
    const options = this.options
    const textarea = options.textarea
    const listenerOptions = { signal: this.abortController.signal }
    textarea.addEventListener('keydown', this.handleKey, listenerOptions)
    textarea.addEventListener('keyup', this.handleKey, listenerOptions)
    textarea.addEventListener('compositionstart', this.handleCompositionStart, listenerOptions)
    textarea.addEventListener('compositionend', this.handleCompositionEnd, listenerOptions)
    textarea.addEventListener('input', this.handleInput, listenerOptions)
    textarea.addEventListener('paste', this.handlePaste, listenerOptions)
    options.signal.addEventListener('abort', this.dispose, {
      once: true,
      signal: this.abortController.signal,
    })
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.abortController.abort()
    this.resetTransientState()
  }

  private readonly handleCompositionStart = (): void => {
    if (this.disposed) return
    this.committedDuringComposition = false
    this.composing = true
    this.setCompositionValue('')
  }

  private readonly handleCompositionEnd = (event: CompositionEvent): void => {
    if (this.disposed) return
    this.composing = false
    if (this.committedDuringComposition) {
      this.committedDuringComposition = false
      this.setCompositionValue('')
      return
    }
    const value = this.compositionValue
    this.setCompositionValue('')
    if (value.length === 0 || value !== event.data) return
    // UI Events updates the control before compositionend when this is the final commit.
    this.options.textarea.value = ''
    this.invokeSession('input', value)
  }

  private readonly handleInput = (event: Event): void => {
    if (this.disposed) return
    const input = event as InputEvent
    if (input.isComposing) {
      this.setCompositionValue(this.inputValue(input.data))
      return
    }
    const value = this.takeInputValue(input.data)
    if (value.length === 0) return
    if (this.composing) {
      this.committedDuringComposition = true
      this.setCompositionValue('')
    }
    const operation = isPasteInput(input.inputType) ? 'paste' : 'input'
    this.invokeSession(operation, value)
  }

  private readonly handlePaste = (event: ClipboardEvent): void => {
    if (this.disposed) return
    if (!event.clipboardData) return
    const value = event.clipboardData.getData('text/plain')
    event.preventDefault()
    this.options.textarea.value = ''
    this.invokeSession('paste', value)
  }

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (this.disposed) return
    this.updateModifierTracking(event)
    const suppressedBeforeCustomHandler = this.suppressedShortcuts.has(event.code)
    const customAllowed = this.allowCustomKey(event)
    if (suppressedBeforeCustomHandler && this.consumeSuppressedShortcut(event)) {
      this.deferredMacCommandPresses.clear()
      return
    }
    if (!customAllowed) {
      this.deferredMacCommandPresses.clear()
      return
    }
    if (this.suppressMacHostShortcut(event)) return
    if (this.suppressComposingKeyLifecycle(event)) {
      this.deferredMacCommandPresses.clear()
      return
    }
    if (this.blockDisabledKey(event)) {
      this.deferredMacCommandPresses.clear()
      return
    }
    if (this.arbitrateShortcut(event)) {
      this.deferredMacCommandPresses.clear()
      return
    }
    if (!isSupportedTerminalKeyCode(event.code)) {
      this.deferredMacCommandPresses.clear()
      return
    }
    if (this.deferMacCommandPress(event)) return
    this.forwardDeferredMacCommandPresses(event)
    this.encodeKey(event)
  }

  private inputValue(fallback: string | null): string {
    const value = this.options.textarea.value
    return value.length > 0 ? value : (fallback ?? '')
  }

  private takeInputValue(fallback: string | null): string {
    const value = this.inputValue(fallback)
    this.options.textarea.value = ''
    return value
  }

  private setCompositionValue(value: string): void {
    this.compositionValue = value
    try {
      this.options.onPreedit?.(value)
    } catch (cause) {
      this.options.onError(cause, 'preedit')
    }
  }

  private invokeSession(
    operation: 'input' | 'paste',
    value: TerminalInputData,
  ): TerminalInputResult {
    if (this.isInputDisabled()) return new Uint8Array()
    this.beforeUserInput()
    try {
      if (operation === 'paste') return this.options.session.paste(value)
      return this.options.session.sendInput(value)
    } catch (cause) {
      this.options.onError(cause, operation)
      return new Uint8Array()
    }
  }

  private allowCustomKey(event: KeyboardEvent): boolean {
    const handler = this.options.hooks?.customKeyEvent
    if (!handler) return true
    try {
      if (handler(event)) return true
      this.suppressInitialKey(event)
      return false
    } catch (cause) {
      this.clearFailedKeyLifecycle(event)
      throw cause
    }
  }

  private clearFailedKeyLifecycle(event: KeyboardEvent): void {
    this.composingKeyPresses.delete(event.code)
    this.deferredMacCommandPresses.clear()
    this.pressedModifierCodes.delete(event.code)
    this.publishedKeyPresses.delete(event.code)
    this.suppressedShortcuts.delete(event.code)
  }

  private blockDisabledKey(event: KeyboardEvent): boolean {
    if (!this.isInputDisabled(event)) return false
    if (event.type === 'keyup' && this.publishedKeyPresses.has(event.code)) return false
    this.suppressInitialKey(event)
    return true
  }

  private isInputDisabled(event?: KeyboardEvent): boolean {
    const predicate = this.options.hooks?.inputDisabled
    if (!predicate) return false
    try {
      return predicate()
    } catch (cause) {
      this.options.onError(cause, 'inputDisabled')
      return event?.type !== 'keyup'
    }
  }

  private suppressInitialKey(event: KeyboardEvent): void {
    if (event.type !== 'keydown' || event.repeat) return
    this.suppressedShortcuts.set(event.code, refusedKeyPolicy)
  }

  private beforeUserInput(): void {
    try {
      this.options.hooks?.beforeUserInput?.()
    } catch (cause) {
      this.options.onError(cause, 'beforeUserInput')
    }
  }

  private updateModifierTracking(event: KeyboardEvent): void {
    const definition = modifierDefinition(event.code)
    if (definition && event.type === 'keydown') this.pressedModifierCodes.add(event.code)
    if (definition && event.type === 'keyup') this.pressedModifierCodes.delete(event.code)
    for (const candidate of modifierDefinitions) {
      if (event.getModifierState(candidate.state)) continue
      this.pressedModifierCodes.delete(candidate.left)
      this.pressedModifierCodes.delete(candidate.right)
    }
  }

  private consumeSuppressedShortcut(event: KeyboardEvent): boolean {
    const policy = this.suppressedShortcuts.get(event.code)
    if (!policy) return false
    if (event.type === 'keyup') {
      this.suppressedShortcuts.delete(event.code)
      return true
    }
    if (!event.repeat) {
      this.suppressedShortcuts.delete(event.code)
      return false
    }
    applyShortcutPolicy(event, policy)
    return true
  }

  private arbitrateShortcut(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return false
    if (isComposingKey(event, this.composing)) return false
    if (event.getModifierState('AltGraph')) return false
    if (this.pasteShortcut.matches(event)) {
      this.claimShortcut(event, pastePressPolicy, pasteRepeatPolicy)
      return true
    }
    const claim = this.hotkeys.arbitrate(this.hotkeyContext(event))
    if (!claim) return false
    this.claimShortcut(event, claim, claim)
    return true
  }

  private claimShortcut(
    event: KeyboardEvent,
    pressPolicy: SuppressedShortcutPolicy,
    repeatPolicy: SuppressedShortcutPolicy,
  ): void {
    this.suppressedShortcuts.set(event.code, repeatPolicy)
    applyShortcutPolicy(event, pressPolicy)
  }

  private hotkeyContext(event: KeyboardEvent): TerminalHotkeyContext {
    const session = this.options.session
    return Object.freeze({
      event,
      getSelection: () => session.getSelection(),
      hasSelection: () => session.selectionCoordinates() !== undefined,
      paste: (data: TerminalInputData) => this.invokeSession('paste', data),
      sendInput: (data: TerminalInputData) => this.invokeSession('input', data),
    })
  }

  private deferMacCommandPress(event: KeyboardEvent): boolean {
    if (this.platform !== 'mac') return false
    if (modifierDefinition(event.code)?.name !== 'super') return false
    if (event.type === 'keydown') {
      if (!event.repeat) this.deferredMacCommandPresses.set(event.code, event)
      return this.deferredMacCommandPresses.has(event.code)
    }
    if (this.deferredMacCommandPresses.delete(event.code)) return true
    if (!this.forwardedMacCommandPresses.delete(event.code)) return true
    return false
  }

  private forwardDeferredMacCommandPresses(event: KeyboardEvent): void {
    if (event.type !== 'keydown') return
    // macOS hides host-owned chord keys, so publish Command only with a terminal-owned key.
    for (const [code, press] of this.deferredMacCommandPresses) {
      this.deferredMacCommandPresses.delete(code)
      this.forwardedMacCommandPresses.add(code)
      this.encodeKey(press)
    }
  }

  private suppressComposingKeyLifecycle(event: KeyboardEvent): boolean {
    if (!this.composingKeyPresses.has(event.code)) return false
    if (event.type === 'keyup') this.composingKeyPresses.delete(event.code)
    return event.type === 'keyup' || event.repeat
  }

  private suppressMacHostShortcut(event: KeyboardEvent): boolean {
    if (this.platform !== 'mac' || event.type !== 'keydown' || !event.metaKey) return false
    if (event.code !== 'Tab' && event.code !== 'Space') return false
    this.suppressInitialKey(event)
    this.deferredMacCommandPresses.clear()
    return true
  }

  private encodeKey(event: KeyboardEvent): void {
    this.beforeUserInput()
    try {
      const input = normalizedKeyInput(
        event,
        this.pressedModifierCodes,
        this.composing,
        this.platform === 'mac',
        this.options.hooks?.macOptionIsMeta?.() === true,
      )
      if (event.type === 'keydown' && !event.repeat) {
        if (input.composing) this.composingKeyPresses.add(event.code)
        if (!input.composing) this.composingKeyPresses.delete(event.code)
      }
      const bytes = this.options.session.key(input, {
        onEncoded: (data) => this.notifyKey(event, data),
      })
      this.updatePublishedKeyPresses(event, bytes)
      if (bytes.length === 0) return
      if (this.screenReaderUsesBrowserDefault(event)) return
      event.preventDefault()
    } catch (cause) {
      if (event.type === 'keyup') this.publishedKeyPresses.delete(event.code)
      this.options.onError(cause, 'key')
    }
  }

  private screenReaderUsesBrowserDefault(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return false
    if (this.options.hooks?.screenReaderMode?.() !== true) return false
    return !event.altKey && !event.ctrlKey
  }

  private updatePublishedKeyPresses(event: KeyboardEvent, bytes: TerminalInputResult): void {
    if (event.type === 'keyup') {
      this.publishedKeyPresses.delete(event.code)
      return
    }
    if (!event.repeat && bytes.length > 0) this.publishedKeyPresses.add(event.code)
  }

  private notifyKey(event: KeyboardEvent, bytes: TerminalInputResult): void {
    if (event.type !== 'keydown') return
    try {
      this.options.hooks?.onKey?.(event, Uint8Array.from(bytes))
    } catch (cause) {
      this.options.onError(cause, 'onKey')
    }
  }

  resetTransientState(): void {
    this.committedDuringComposition = false
    this.composing = false
    this.setCompositionValue('')
    this.composingKeyPresses.clear()
    this.deferredMacCommandPresses.clear()
    this.forwardedMacCommandPresses.clear()
    this.pressedModifierCodes.clear()
    this.publishedKeyPresses.clear()
    this.suppressedShortcuts.clear()
    this.options.textarea.value = ''
  }
}

class BrowserInputLifecycleController implements DomInputLifecycleController {
  private readonly abortController = new AbortController()
  private disposed = false
  private focused = false

  constructor(private readonly options: DomInputLifecycleControllerOptions) {
    try {
      this.installListeners()
    } catch (cause) {
      this.disposed = true
      this.abortController.abort()
      throw cause
    }
  }

  private installListeners(): void {
    const options = this.options
    const listenerOptions = { signal: this.abortController.signal }
    const view = inputWindow(options.textarea)
    options.textarea.addEventListener('focus', this.handleFocus, listenerOptions)
    options.textarea.addEventListener('blur', this.handleBlur, listenerOptions)
    view.addEventListener('focus', this.handleWindowFocus, listenerOptions)
    view.addEventListener('blur', this.handleWindowBlur, listenerOptions)
    options.textarea.ownerDocument.addEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
      listenerOptions,
    )
    options.signal.addEventListener('abort', this.dispose, {
      once: true,
      signal: this.abortController.signal,
    })
    const document = options.textarea.ownerDocument
    if (document.hasFocus() && document.activeElement === options.textarea) this.setFocused(true)
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.abortController.abort()
  }

  private readonly handleFocus = (): void => {
    if (this.disposed) return
    this.setFocused(true)
  }

  private readonly handleBlur = (): void => {
    if (this.disposed) return
    this.handleFocusLoss()
  }

  private readonly handleWindowFocus = (): void => {
    if (this.disposed || !this.textareaOwnsFocus()) return
    this.setFocused(true)
  }

  private readonly handleWindowBlur = (): void => {
    if (this.disposed || !this.textareaOwnsFocus()) return
    this.handleFocusLoss()
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed) return
    const visible = this.options.textarea.ownerDocument.visibilityState !== 'hidden'
    if (!visible) this.options.onResetTransientState?.()
    this.options.onDocumentVisible?.(visible)
  }

  private setFocused(focused: boolean): void {
    if (focused === this.focused) return
    try {
      this.options.session.setFocused(focused)
      this.focused = focused
      this.options.onFocused?.(focused)
    } catch (cause) {
      this.options.onError(cause, 'focus')
    }
  }

  private handleFocusLoss(): void {
    if (!this.focused) return
    this.options.onResetTransientState?.()
    this.setFocused(false)
  }

  private textareaOwnsFocus(): boolean {
    return this.options.textarea.ownerDocument.activeElement === this.options.textarea
  }
}

export function createDomInputController(options: DomInputControllerOptions): DomInputController {
  return new BrowserInputController(options)
}

export function createDomInputLifecycleController(
  options: DomInputLifecycleControllerOptions,
): DomInputLifecycleController {
  return new BrowserInputLifecycleController(options)
}
