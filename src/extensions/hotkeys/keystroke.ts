import {
  keyInputFromKeyboardEvent,
  parseHotkey,
  validateHotkey,
  type KeymapPlatform,
} from '@fregat/hotkeys'
import { isSupportedTerminalKeyCode } from '../../term/session.js'
import type { TerminalKeyInput } from '../../term/types.js'

const punctuationCodes: Readonly<Record<string, string>> = {
  ' ': 'Space',
  '`': 'Backquote',
  '~': 'Backquote',
  '-': 'Minus',
  _: 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  '/': 'Slash',
  '?': 'Slash',
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
}

export function terminalKeystroke(keys: string, platform: KeymapPlatform): TerminalKeyInput | null {
  if (/\s/.test(keys.trim())) return null
  const normalized = normalizeTerminalKeystroke(keys)
  if (!validateHotkey(normalized).valid) return null
  const parsed = parseHotkey(normalized, platform)
  const key = parsed.key ?? ''
  let code = parsed.code ?? punctuationCodes[key] ?? key
  if (/^[A-Z]$/i.test(key)) code = `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) code = `Digit${key}`
  if (!isSupportedTerminalKeyCode(code)) return null
  let text = ''
  if (Array.from(key).length === 1) text = parsed.shift ? key.toUpperCase() : key.toLowerCase()
  if (key === 'Space') text = ' '
  return {
    action: 'press',
    composing: false,
    code,
    text,
    modifiers: {
      ...(parsed.ctrl && { control: 'unknown' }),
      ...(parsed.alt && { alt: 'unknown' }),
      ...(parsed.shift && { shift: 'unknown' }),
      ...(parsed.meta && { super: 'unknown' }),
    },
  }
}

export type TerminalSendKeystrokeArgs = { readonly keystroke: string } | { readonly text: string }

export function readSendKeystrokeArgs(value: unknown): TerminalSendKeystrokeArgs | null {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) return null
  if (
    Object.keys(value)[0] === 'keystroke' &&
    'keystroke' in value &&
    typeof value.keystroke === 'string'
  )
    return { keystroke: value.keystroke }
  if (Object.keys(value)[0] === 'text' && 'text' in value && typeof value.text === 'string')
    return { text: value.text }
  return null
}

export function normalizeTerminalKeystroke(keys: string): string {
  if (keys.includes('+')) return keys
  return keys.replace(/^(?:(?:ctrl|control|alt|shift|cmd|super|meta|fn)-)+/i, (modifiers) =>
    modifiers.replace(/-/g, '+').replace(/cmd|super/gi, 'Meta'),
  )
}

export function terminalKeyFromEvent(
  event: KeyboardEvent,
  platform: KeymapPlatform,
): TerminalKeyInput {
  const input = keyInputFromKeyboardEvent(event, platform)
  let action: TerminalKeyInput['action'] = 'press'
  if (input.repeat) action = 'repeat'
  if (input.type === 'keyup') action = 'release'
  return {
    action,
    code: input.code,
    composing: input.composing,
    text: Array.from(event.key).length === 1 ? event.key : '',
    modifiers: {
      capsLock: event.getModifierState('CapsLock'),
      numLock: event.getModifierState('NumLock'),
      ...(input.modifiers.ctrl && { control: 'unknown' }),
      ...(input.modifiers.alt && { alt: 'unknown' }),
      ...(input.modifiers.shift && { shift: 'unknown' }),
      ...(input.modifiers.meta && { super: 'unknown' }),
    },
  }
}
