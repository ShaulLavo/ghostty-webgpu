import type { TerminalApi } from '../../dom/terminal-api.js'
import type { GhosttyWebGpuTerminalSubscription } from '../../dom/types.js'
import {
  registerTerminalHotkeys,
  type TerminalHotkeyOwnership,
  type TerminalHotkeyRegistration,
} from './focus.js'
import type { TerminalClipboard, TerminalCommandId } from './commands.js'

export type TerminalHotkeysOptions = TerminalHotkeyOwnership & {
  readonly clipboard?: TerminalClipboard
  readonly onError?: (cause: unknown, operation: TerminalCommandId) => void
}

export interface TerminalHotkeyConnection {
  readonly registration: TerminalHotkeyRegistration | undefined
  dispose(): void
}

export function attachTerminalHotkeys(
  terminal: TerminalApi<'sync'>,
  options: TerminalHotkeysOptions = { mode: 'standalone' },
): TerminalHotkeyConnection {
  const readState = () => terminal.inputModes
  readState()
  let registration: TerminalHotkeyRegistration | undefined
  const connection = terminal.connectInput((input) => {
    if (input.type !== 'key' || !('event' in input)) return 'pass'
    return registration?.claim(input.event) ?? 'pass'
  })
  let opened: GhosttyWebGpuTerminalSubscription | undefined
  connection.signal.addEventListener('abort', () => opened?.dispose(), { once: true })
  function attach(element: HTMLElement): void {
    if (registration || connection.signal.aborted) return
    try {
      const clipboard = options.clipboard ?? element.ownerDocument.defaultView?.navigator.clipboard
      registration = registerTerminalHotkeys({
        ...options,
        element,
        terminal,
        clipboard,
        hasSelection: () => terminal.getSelection() !== undefined,
        signal: connection.signal,
        readState,
        onError: options.onError ?? ((cause, operation) => console.error(operation, cause)),
      })
    } catch (cause) {
      connection.dispose()
      throw cause
    }
  }
  try {
    opened = terminal.on('open', attach)
    if (connection.signal.aborted) opened.dispose()
    if (terminal.element && terminal.lifecycle === 'open') attach(terminal.element)
  } catch (cause) {
    connection.dispose()
    throw cause
  }
  return {
    get registration() {
      return registration
    },
    dispose: () => connection.dispose(),
  }
}
