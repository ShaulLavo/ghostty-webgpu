import {
  areHotkeysEqual,
  createBrowserDispatcher,
  detectPlatform,
  parseHotkey,
  type FocusNode,
  type HostedBrowserDispatcher,
  type HostedFocusNode,
  type KeymapEntry,
  type Platform,
} from '@shaulavo/hotkeys'
import { createTerminalCommands, type TerminalCommandOptions } from './commands.js'
import { terminalKeyContext, type TerminalKeyContextState } from './context.js'
import {
  parseTerminalKeystroke,
  readSendKeystrokeArgs,
  terminalKeyFromEvent,
  terminalKeystroke,
} from './keystroke.js'
import { ghosttyKeymap } from './packs.js'
import type { TerminalKeyInput } from '../../term/types.js'

export type TerminalHotkeyOwnership =
  | {
      readonly mode: 'standalone'
      readonly bindings?: readonly KeymapEntry[]
      readonly keymap?: readonly KeymapEntry[]
      readonly platform?: Platform
    }
  | {
      readonly mode: 'hosted'
      readonly dispatcher: HostedBrowserDispatcher
      readonly parent: HostedFocusNode
      readonly platform: Platform
    }

export type TerminalHotkeyRegistrationOptions = TerminalHotkeyOwnership &
  Omit<TerminalCommandOptions, 'sendKeystroke'> & {
    readonly element: HTMLElement
    readonly readState: () => TerminalKeyContextState
  }

export interface TerminalHotkeyRegistration {
  readonly node: FocusNode<KeyboardEvent>
  claim(event: KeyboardEvent): 'claim' | 'pass'
  dispose(): void
}

export function registerTerminalHotkeys(
  options: TerminalHotkeyRegistrationOptions,
): TerminalHotkeyRegistration {
  const platform = options.platform ?? detectPlatform()
  const defaults: readonly KeymapEntry[] = ghosttyKeymap[platform]
  const lifetime = new AbortController()
  let disposed = false
  const nativePresses = new Map<
    string,
    { readonly input: TerminalKeyInput; readonly sourceRelease: boolean }
  >()
  const nativeSent = new WeakSet<KeyboardEvent>()
  let dispatcher: HostedBrowserDispatcher
  let disposeDispatcher: (() => void) | undefined
  if (options.mode === 'hosted') {
    dispatcher = options.dispatcher
  } else {
    const standalone = createBrowserDispatcher({
      root: options.element,
      platform,
      keymap: (options.keymap ?? defaults).concat(options.bindings ?? []),
      replay: (_input, event) =>
        send(() =>
          options.terminal.sendGeneratedInput({
            type: 'key',
            input: terminalKeyFromEvent(event, platform),
          }),
        ),
    })
    dispatcher = standalone
    disposeDispatcher = standalone.dispose
  }
  const commands = createTerminalCommands({
    ...options,
    signal: lifetime.signal,
    sendKeystroke: (event) => {
      if (options.signal.aborted || disposed) return false
      const args = readSendKeystrokeArgs(event.args)
      if (!args) return false
      if ('text' in args) {
        send(() => options.terminal.sendGeneratedInput({ type: 'text', data: args.text }))
        return true
      }
      const stroke = parseTerminalKeystroke(args.keystroke)
      if (!stroke) return false
      const source = event.source
      if (source && areHotkeysEqual(stroke, parseHotkey(source, platform), platform)) {
        const input = terminalKeyFromEvent(source, platform)
        nativePresses.set(source.code, { input, sourceRelease: true })
        nativeSent.add(source)
        send(() => options.terminal.sendGeneratedInput({ type: 'key', input }))
        return true
      }
      const input = terminalKeystroke(stroke, platform)
      if (!input) return false
      const encoded = source?.repeat ? { ...input, action: 'repeat' as const } : input
      if (source) nativePresses.set(source.code, { input: encoded, sourceRelease: false })
      send(() => options.terminal.sendGeneratedInput({ type: 'key', input: encoded }))
      return true
    },
  })
  const node = dispatcher.createNode({
    parent: options.mode === 'hosted' ? options.parent : null,
    readContext: () => terminalKeyContext(options.readState()),
    commands,
  })
  const detach = dispatcher.attachElement(node, options.element)
  const unobserve = dispatcher.observeKeys({
    beforeKey: observeKey,
    reset: () => nativePresses.clear(),
  })

  function send(run: () => unknown): void {
    if (disposed || options.signal.aborted) return
    try {
      void Promise.resolve(run()).catch((cause: unknown) =>
        options.onError(cause, 'terminal.sendKeystroke'),
      )
    } catch (cause) {
      options.onError(cause, 'terminal.sendKeystroke')
    }
  }
  function observeKey(event: KeyboardEvent): void {
    if (event.type !== 'keyup' || !nativePresses.has(event.code)) return
    const mapped = nativePresses.get(event.code)
    nativePresses.delete(event.code)
    const input =
      mapped && !mapped.sourceRelease
        ? { ...mapped.input, action: 'release' as const }
        : terminalKeyFromEvent(event, platform)
    // The shared dispatcher swallows claimed releases at document capture.
    nativeSent.add(event)
    send(() => options.terminal.sendGeneratedInput({ type: 'key', input }))
  }
  function claim(event: KeyboardEvent): 'claim' | 'pass' {
    if (disposed || options.signal.aborted) return 'pass'
    const claimed = dispatcher.claimKeybinding(event)
    if (nativeSent.has(event)) return 'claim'
    return claimed ? 'claim' : 'pass'
  }
  function dispose(): void {
    if (disposed) return
    lifetime.abort()
    disposed = true
    nativePresses.clear()
    options.signal.removeEventListener('abort', dispose)
    unobserve()
    detach()
    node.remove()
    disposeDispatcher?.()
  }
  options.signal.addEventListener('abort', dispose, { once: true })
  if (options.signal.aborted) dispose()
  return { node, claim, dispose }
}
