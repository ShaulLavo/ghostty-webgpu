import { isSupportedTerminalKeyCode, type TerminalSession } from '../term/session.js'
import type {
  TerminalInputData,
  TerminalKeyAction,
  TerminalKeyInput,
  TerminalModifierSide,
  TerminalModifiers,
} from '../term/types.js'
import type { GhosttyWebGpuTerminalCopy } from './types.js'

type InputSession = Pick<
  TerminalSession<unknown>,
  'getSelection' | 'key' | 'paste' | 'selectionCoordinates' | 'sendInput' | 'setFocused'
>

export interface DomInputControllerOptions {
  readonly copySelection?: GhosttyWebGpuTerminalCopy
  readonly isApplePlatform: boolean
  readonly onDocumentVisible?: (visible: boolean) => void
  readonly onError: (cause: unknown, operation: string) => void
  readonly onFocused?: (focused: boolean) => void
  readonly session: InputSession
  readonly signal: AbortSignal
  readonly textarea: HTMLTextAreaElement
}

export interface DomInputController {
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
): TerminalKeyInput {
  const composing = isComposingKey(event, locallyComposing)
  const modifiers = activeModifiers(event, pressedCodes)
  const text = browserKeyText(event, composing)
  return {
    action: keyAction(event),
    code: event.code,
    composing,
    consumedModifiers: consumedModifiers(event, modifiers, text, isApplePlatform),
    modifiers,
    text,
  }
}

function isPasteShortcut(event: KeyboardEvent): boolean {
  if (event.code !== 'KeyV' || event.getModifierState('AltGraph')) return false
  return event.getModifierState('Control') || event.getModifierState('Meta')
}

function isCopyShortcut(event: KeyboardEvent, isApplePlatform: boolean): boolean {
  if (!isApplePlatform || event.code !== 'KeyC') return false
  if (event.getModifierState('AltGraph')) return false
  return event.getModifierState('Meta')
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

class BrowserInputController implements DomInputController {
  private readonly abortController = new AbortController()
  private composing = false
  private disposed = false
  private readonly pressedModifierCodes = new Set<string>()
  private readonly suppressedShortcutCodes = new Set<string>()

  constructor(private readonly options: DomInputControllerOptions) {
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
    textarea.addEventListener('focus', this.handleFocus, listenerOptions)
    textarea.addEventListener('blur', this.handleBlur, listenerOptions)
    textarea.ownerDocument.addEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
      listenerOptions,
    )
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
    this.composing = true
    this.options.textarea.value = ''
  }

  private readonly handleCompositionEnd = (): void => {
    if (this.disposed) return
    this.composing = false
  }

  private readonly handleInput = (event: Event): void => {
    if (this.disposed) return
    const input = event as InputEvent
    if (input.isComposing) return
    const value = this.committedInput(input)
    if (value.length === 0) return
    const operation = isPasteInput(input.inputType) ? 'paste' : 'input'
    this.invokeSession(operation, value)
  }

  private readonly handlePaste = (event: ClipboardEvent): void => {
    if (this.disposed || !event.clipboardData) return
    const value = event.clipboardData.getData('text/plain')
    event.preventDefault()
    this.options.textarea.value = ''
    this.invokeSession('paste', value)
  }

  private readonly handleFocus = (): void => {
    if (this.disposed) return
    this.setFocused(true)
  }

  private readonly handleBlur = (): void => {
    if (this.disposed) return
    this.resetTransientState()
    this.setFocused(false)
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed) return
    const visible = this.options.textarea.ownerDocument.visibilityState !== 'hidden'
    if (!visible) this.resetTransientState()
    this.options.onDocumentVisible?.(visible)
  }

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (this.disposed) return
    this.updateModifierTracking(event)
    if (this.consumeSuppressedShortcut(event)) return
    if (event.type === 'keydown' && isPasteShortcut(event)) {
      this.suppressedShortcutCodes.add(event.code)
      return
    }
    if (event.type === 'keydown' && this.copySelection(event)) return
    if (!isSupportedTerminalKeyCode(event.code)) return
    this.encodeKey(event)
  }

  private committedInput(event: InputEvent): string {
    const textarea = this.options.textarea
    const value = textarea.value.length > 0 ? textarea.value : (event.data ?? '')
    textarea.value = ''
    return value
  }

  private invokeSession(operation: 'input' | 'paste', value: TerminalInputData): void {
    try {
      if (operation === 'paste') this.options.session.paste(value)
      if (operation === 'input') this.options.session.sendInput(value)
    } catch (cause) {
      this.options.onError(cause, operation)
    }
  }

  private setFocused(focused: boolean): void {
    try {
      this.options.session.setFocused(focused)
      this.options.onFocused?.(focused)
    } catch (cause) {
      this.options.onError(cause, 'focus')
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
    if (!this.suppressedShortcutCodes.has(event.code)) return false
    if (event.type === 'keyup') {
      this.suppressedShortcutCodes.delete(event.code)
      return true
    }
    event.preventDefault()
    return true
  }

  private copySelection(event: KeyboardEvent): boolean {
    const copy = this.options.copySelection
    if (event.type !== 'keydown') return false
    if (!copy || !isCopyShortcut(event, this.options.isApplePlatform)) return false
    try {
      if (!this.options.session.selectionCoordinates()) return false
      const text = this.options.session.getSelection()
      if (text === undefined) return false
      this.suppressedShortcutCodes.add(event.code)
      event.preventDefault()
      reportPromiseRejection(copy(text), this.options.onError)
      return true
    } catch (cause) {
      this.options.onError(cause, 'copy')
      return true
    }
  }

  private encodeKey(event: KeyboardEvent): void {
    try {
      const input = normalizedKeyInput(
        event,
        this.pressedModifierCodes,
        this.composing,
        this.options.isApplePlatform,
      )
      const bytes = this.options.session.key(input)
      if (bytes.length > 0) event.preventDefault()
    } catch (cause) {
      this.options.onError(cause, 'key')
    }
  }

  private resetTransientState(): void {
    this.composing = false
    this.pressedModifierCodes.clear()
    this.suppressedShortcutCodes.clear()
    this.options.textarea.value = ''
  }
}

export function createDomInputController(options: DomInputControllerOptions): DomInputController {
  return new BrowserInputController(options)
}
