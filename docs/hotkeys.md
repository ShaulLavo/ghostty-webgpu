# Terminal hotkeys

`attachTerminalHotkeys(terminal, options)` owns a finite original-input connection. It uses `@fregat/hotkeys` with the main terminal native owner. Load it explicitly for an interactive standalone terminal:

```ts
import { Terminal, attachTerminalHotkeys } from 'ghostty-webgpu'

const terminal = await Terminal.create()
const connection = attachTerminalHotkeys(terminal)
await terminal.open(container)
```

The connection attaches when the host opens, or synchronously when it is already open.
Its disposer removes the registration. Terminal disposal aborts the connection and pending
clipboard work. A second finite connection is rejected while the first owns original input.

## Standalone bindings

`terminalDefaultPack` exports platform-indexed binding data. macOS uses Cmd+C/V/A/K for copy,
paste, select all and clear. Linux and Windows use Ctrl+Shift+C/V/A/K. Font size uses Cmd on
macOS and Ctrl elsewhere: `=`, `Shift++`, `-` and `0`.

Overrides follow the library's binding format:

```ts
attachTerminalHotkeys(terminal, {
  mode: 'standalone',
  bindings: [{ keys: 'Ctrl+Q', command: 'terminal.clear', context: 'Terminal', source: 'user' }],
})
```

Clipboard commands use the owning window's Clipboard API. An embedder can supply
`clipboard: { readText, writeText }` and `onError(cause, operation)`. Copy declines when the
selection is empty. Paste completion and queued font changes stop on disposal.
Clear erases the display and scrollback while preserving native protocol modes.

## Hosted focus adapter

Pass the existing window dispatcher and the Workspace parent:

```ts
attachTerminalHotkeys(terminal, {
  mode: 'hosted',
  dispatcher: windowKeymap.hotkeys,
  parent: windowKeymap.parentFor('terminal'),
  platform,
})
```

The connection adds a `Terminal` focus node and its commands. The host owns all binding data
and the single matcher/listener. `terminalShellKeysPack` is exported opt-in data for Ctrl+A–Z
and readline Alt keys. `terminalDefaultPack` is also available to hosted presets.

The node reads `terminal.inputModes` synchronously before matching. It publishes `Terminal`,
`mode: normal | alternate`, and `mouse: off | on`. The main entry reads existing native screen and mouse state before matching.

## Native input ownership

An unbound key reaches native encoding once. A shallower application binding claims its key;
a deeper `terminal.sendKeystroke` binding sends it to the shell. Arguments are exactly
`{ keystroke: string }` or `{ text: string }`. Keystrokes accept the library's `Ctrl+B` notation
and Zed's `ctrl-b` notation. Invalid arguments decline the command.

Original DOM events arbitrate through the finite synchronous claim/pass owner
before native encoding. Resolved commands use `sendGeneratedInput`, which sends a
typed key, text or paste directly to the native execution owner. Native terminal replies bypass
original-input owners. Composition remains native text input. Programmatic original key, text and paste calls use the
same claim boundary. A finite claim stops there; a pass reaches any explicitly installed general
input contribution and then native encoding. Hotkeys attachment creates no general manager.
The peer-owned `Terminal.use` surface retains its own registration and event semantics.

A finite handler must be a function returning exactly `claim` or `pass` synchronously.
Invalid decisions report a contract error and continue through the pass path. Rejected
thenables are observed for diagnostics; their completion never changes that input decision.
Immediate and deferred hotkeys setup failures release the lease and its open subscription,
so a replacement can attach to the same native terminal.

The hotkeys helper checks immediate native-mode authority before acquiring its lease. A JavaScript
worker attachment fails with its native-mode capability error. The finite connection requires
the synchronous main entry. Worker `connectInput` returns a
rejected Promise with a capability error; disposed calls also reject asynchronously. Existing
worker input and general extension APIs retain their own actor conventions.

The adapter subscribes directly to `dispatcher.observeKeys({ beforeKey, reset })`. It remembers
native-selected physical presses and forwards their matching release once before the dispatcher
consumes it. Focus movement retains the original terminal owner. Blur, hidden, `releaseAll`,
dispatcher disposal and connection disposal clear that ownership. Disposal removes the node,
commands and observer; the terminal execution owner remains in place.

## Packaging

The consumer uses `catalog:`. The root workspace supplies the reviewed exact hotkeys version. The standalone family catalog
resolves its pinned artifact. Pack with Bun so the published manifest
contains the resolved version. Publication and mirror cutover follow the root roadmap.
