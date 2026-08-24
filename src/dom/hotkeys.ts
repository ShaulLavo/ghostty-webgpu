import {
  matchesKeyboardEvent,
  normalizeRegisterableHotkey,
  parseHotkey,
  type Hotkey,
  type ParsedHotkey,
  type RegisterableHotkey,
} from '@tanstack/hotkeys'
import type {
  TerminalHotkeyBinding,
  TerminalHotkeyContext,
  TerminalHotkeyDecision,
} from './types.js'

export type DomHotkeyPlatform = 'linux' | 'mac' | 'windows'

export interface CompiledDomHotkey {
  readonly normalized: Hotkey
  readonly matches: (event: KeyboardEvent) => boolean
}

export interface TerminalHotkeyClaim {
  readonly id: string
  readonly preventDefault: boolean
  readonly stopPropagation: boolean
}

export interface CompiledTerminalHotkeyBindings {
  readonly arbitrate: (context: TerminalHotkeyContext) => TerminalHotkeyClaim | undefined
}

export interface CompileTerminalHotkeyBindingsOptions {
  readonly onError: (cause: unknown, operation: string) => void
  readonly platform: DomHotkeyPlatform
}

interface CompiledBinding {
  readonly claim: TerminalHotkeyClaim
  readonly hotkey: CompiledDomHotkey
  readonly onTrigger: TerminalHotkeyBinding['onTrigger']
}

export function hotkeyPlatformForWindow(view: Window): DomHotkeyPlatform {
  const platform = view.navigator.platform.toLowerCase()
  const userAgent = view.navigator.userAgent.toLowerCase()
  if (platform.includes('mac') || userAgent.includes('mac')) return 'mac'
  if (platform.includes('win') || userAgent.includes('win')) return 'windows'
  return 'linux'
}

function freezeParsedHotkey(parsed: ParsedHotkey): ParsedHotkey {
  Object.freeze(parsed.modifiers)
  return Object.freeze(parsed)
}

export function compileHotkey(
  hotkey: RegisterableHotkey,
  platform: DomHotkeyPlatform,
): CompiledDomHotkey {
  const normalized = normalizeRegisterableHotkey(hotkey, platform)
  const parsed = freezeParsedHotkey(parseHotkey(normalized, platform))
  return Object.freeze({
    matches: (event: KeyboardEvent) => matchesKeyboardEvent(event, parsed, platform),
    normalized,
  })
}

function assertUniqueBindingIds(bindings: readonly TerminalHotkeyBinding[]): void {
  const ids = new Set<string>()
  for (const binding of bindings) {
    if (binding.id.length === 0) continue
    if (ids.has(binding.id)) {
      throw new TypeError(`Duplicate terminal hotkey binding id: ${binding.id}`)
    }
    ids.add(binding.id)
  }
}

function compileBinding(
  binding: TerminalHotkeyBinding,
  platform: DomHotkeyPlatform,
): CompiledBinding {
  const claim = Object.freeze({
    id: binding.id,
    preventDefault: binding.preventDefault ?? true,
    stopPropagation: binding.stopPropagation ?? true,
  })
  return Object.freeze({
    claim,
    hotkey: compileHotkey(binding.hotkey, platform),
    onTrigger: binding.onTrigger,
  })
}

function triggerBinding(
  binding: CompiledBinding,
  context: TerminalHotkeyContext,
  onError: CompileTerminalHotkeyBindingsOptions['onError'],
): TerminalHotkeyDecision {
  try {
    const decision = binding.onTrigger(context)
    if (decision === 'claim' || decision === 'passthrough') return decision
    throw new TypeError(`Hotkey ${binding.claim.id} returned an invalid decision`)
  } catch (cause) {
    onError(cause, `hotkey.${binding.claim.id}`)
    return 'claim'
  }
}

function arbitrateBindings(
  bindings: readonly CompiledBinding[],
  context: TerminalHotkeyContext,
  onError: CompileTerminalHotkeyBindingsOptions['onError'],
): TerminalHotkeyClaim | undefined {
  for (const binding of bindings) {
    if (!binding.hotkey.matches(context.event)) continue
    const decision = triggerBinding(binding, context, onError)
    if (decision === 'passthrough') continue
    return binding.claim
  }
  return undefined
}

export function compileTerminalHotkeyBindings(
  bindings: readonly TerminalHotkeyBinding[],
  options: CompileTerminalHotkeyBindingsOptions,
): CompiledTerminalHotkeyBindings {
  assertUniqueBindingIds(bindings)
  const onError = options.onError
  const platform = options.platform
  const compiled = Object.freeze(bindings.map((binding) => compileBinding(binding, platform)))
  return Object.freeze({
    arbitrate: (context: TerminalHotkeyContext) => arbitrateBindings(compiled, context, onError),
  })
}
