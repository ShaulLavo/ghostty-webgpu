import {
  createBrowserDispatcher,
  detectPlatform,
  normalizeHotkey,
  normalizeHotkeyFromEvent,
  type BrowserDispatcher,
  type FocusNode,
  type KeymapEntry,
  type KeymapPlatform,
} from '@fregat/hotkeys'
import { createTerminalCommands, type TerminalCommandOptions } from './commands.js'
import { terminalKeyContext, type TerminalKeyContextState } from './context.js'
import {
  normalizeTerminalKeystroke,
  readSendKeystrokeArgs,
  terminalKeyFromEvent,
  terminalKeystroke,
} from './keystroke.js'
import { terminalDefaultPack } from './packs.js'
import type { TerminalKeyInput } from '../../term/types.js'

export type TerminalHotkeyOwnership =
  | {
      readonly mode: 'standalone'
      readonly bindings?: readonly KeymapEntry[]
      readonly platform?: KeymapPlatform
    }
  | {
      readonly mode: 'hosted'
      readonly dispatcher: BrowserDispatcher
      readonly parent: FocusNode<KeyboardEvent>
      readonly platform: KeymapPlatform
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
  const lifetime = new AbortController()
  let disposed = false
  const nativePresses = new Map<
    string,
    { readonly input: TerminalKeyInput; readonly sourceRelease: boolean }
  >()
  const nativeSent = new WeakSet<KeyboardEvent>()
  const dispatcher =
    options.mode === 'hosted'
      ? options.dispatcher
      : createBrowserDispatcher({
          root: options.element,
          platform,
          keymap: [...terminalDefaultPack[platform], ...(options.bindings ?? [])],
          replay: (_input, event) =>
            send(() =>
              options.terminal.sendGeneratedInput({
                type: 'key',
                input: terminalKeyFromEvent(event, platform),
              }),
            ),
        })
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
      const keys = normalizeTerminalKeystroke(args.keystroke)
      const source = event.source
      if (
        source &&
        normalizeHotkey(keys, platform) === normalizeHotkeyFromEvent(source, platform)
      ) {
        nativePresses.set(source.code, {
          input: terminalKeyFromEvent(source, platform),
          sourceRelease: true,
        })
        nativeSent.add(source)
        send(() =>
          options.terminal.sendGeneratedInput({
            type: 'key',
            input: terminalKeyFromEvent(source, platform),
          }),
        )
        return true
      }
      const input = terminalKeystroke(keys, platform)
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
    if (options.mode === 'standalone') dispatcher.dispose()
  }
  options.signal.addEventListener('abort', dispose, { once: true })
  if (options.signal.aborted) dispose()
  return { node, claim, dispose }
}
