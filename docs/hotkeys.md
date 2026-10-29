# Terminal hotkeys

Core supports custom input ownership but ships no keymap. Install the optional `@fregat/hotkeys` peer and import the add-on explicitly:

```ts
import { Terminal } from 'ghostty-webgpu'
import { attachTerminalHotkeys } from 'ghostty-webgpu/hotkeys'

const terminal = await Terminal.create()
const connection = attachTerminalHotkeys(terminal)
await terminal.open(container)
```

The connection attaches when the terminal opens, or immediately if it is already open. Its disposer removes the registration. Terminal disposal aborts the connection and pending clipboard work. One finite original-input connection owns a terminal at a time. The add-on requires the synchronous main-thread terminal. Worker terminals use native VT encoding without these bindings.

## Ghostty keymap

`ghosttyKeymap` exports binding data indexed by `mac`, `linux`, and `windows`. The add-on detects the platform unless `platform` is supplied.

| Action                  | macOS                      | Linux and Windows              |
| ----------------------- | -------------------------- | ------------------------------ |
| Copy                    | Cmd+C                      | Ctrl+Shift+C                   |
| Select all              | Cmd+A                      | Ctrl+Shift+A                   |
| Clear above the prompt  | Cmd+K                      | Ctrl+Shift+K                   |
| Increase font size      | Cmd+= or Cmd+Shift++       | Ctrl+= or Ctrl+Shift++         |
| Decrease font size      | Cmd+-                      | Ctrl+-                         |
| Reset font size         | Cmd+0                      | Ctrl+0                         |
| Scroll to top or bottom | Cmd+Home or Cmd+End        | Shift+Home or Shift+End        |
| Scroll one page         | Cmd+PageUp or Cmd+PageDown | Shift+PageUp or Shift+PageDown |

On Mac, Cmd+Left, Cmd+Right, and Cmd+Backspace send `\x01`, `\x05`, and `\x15`. Option+Left and Option+Right send `\x1bb` and `\x1bf`. These text actions bypass VT key protocols. Option+letters still compose characters through native input. Option+Backspace remains a native encoded key.

Clear removes the selection, scrollback, and rows above the cursor. The prompt row stays at the top, and protocol modes remain active. Clear does nothing on the alternate screen.

Paste uses the browser's `paste` event and core's bracketed-paste path. The keymap has no paste binding, so it does not request clipboard-read permission. `terminal.paste` remains available to hosts that can read the clipboard silently. Copy uses the owning window's Clipboard API and declines an empty selection. Supply `clipboard: { readText, writeText }` and `onError(cause, operation)` for a different clipboard policy. Clipboard completions and queued font changes stop on disposal.

## Override or replace bindings

`bindings` appends to the selected keymap. User bindings can override defaults:

```ts
attachTerminalHotkeys(terminal, {
  mode: 'standalone',
  bindings: [{ keys: 'Ctrl+Q', command: 'terminal.clear', context: 'Terminal', source: 'user' }],
})
```

`keymap: []` replaces the defaults with an empty map. `bindings` still appends to that replacement.

For screen-reader integration, pass `screenReaderMode: () => enabled`. Share the same predicate with `inputHooks.screenReaderMode` when constructing a host from a session. The five Mac text bindings match only while that predicate is false. Browser defaults remain governed by core's screen-reader input hook.

## Share a host dispatcher

```ts
import { ghosttyKeymap, terminalShellKeysPack } from 'ghostty-webgpu/hotkeys'

attachTerminalHotkeys(terminal, {
  mode: 'hosted',
  dispatcher: windowKeymap.hotkeys,
  parent: windowKeymap.parentFor('terminal'),
  platform,
})
```

The connection adds a `Terminal` focus node and its commands. The host owns all binding data and the single matcher. Add `ghosttyKeymap[platform]` to the host's keymap to use the same defaults. `terminalShellKeysPack` is opt-in data for Ctrl+A through Ctrl+Z and readline Alt keys.

The focus node reads native input modes and the screen-reader predicate before each match. It publishes `Terminal`, `mode: normal | alternate`, `mouse: off | on`, and `screenReader: off | on`.

## Native input ownership

An unbound key reaches native encoding once. A shallower application binding claims its key. A deeper `terminal.sendKeystroke` binding sends it to the shell. Arguments are exactly `{ keystroke: string }` or `{ text: string }`. Keystrokes accept `Ctrl+B` and Zed's `ctrl-b` notation. Invalid arguments decline the command.

Original DOM events arbitrate through the synchronous claim/pass owner before native encoding. Resolved commands use `sendGeneratedInput`, which sends a typed key, text, or paste directly to the native owner. Native terminal replies bypass original-input owners. Composition remains native text input. A finite claim stops forwarding. A pass reaches any installed general input contribution and then native encoding. Hotkeys attachment creates no general extension manager.

The finite handler must return exactly `claim` or `pass` synchronously. Invalid decisions report an error and continue through the pass path. Rejected thenables are observed for diagnostics. Their completion never changes the input decision. Setup failures release the lease and open subscription so a replacement can attach.

The adapter remembers native-selected physical presses and forwards each matching release once. Focus movement retains the original owner. Blur, hidden documents, dispatcher resets, and disposal clear ownership. Disposal removes the node, commands, and observer while leaving the terminal alive.
