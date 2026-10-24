# ghostty-webgpu-line-editor

Readline-style editing for local shells hosted by ghostty-webgpu. Working package name and current version `0.0.3`.

The package provides a browser-independent model, keymap, history, read lifecycle and a `readline()` terminal extension. The extension owns input while a read is active, renders the prompt through the terminal API, and exposes `print()` for output that arrives during editing.

The terminal peer dependency is optional for users of the standalone editing model and history.
The `readline()` extension attaches to a `ghostty-webgpu` terminal supplied by the host.

## Editing model

`EditModel` edits grapheme boundaries and exposes a snapshot containing `text`, a UTF16 `cursor` offset, `revision` and reverse-search state. `keyCommand()` maps keyboard keys and modifiers to typed editing commands. Displayed cell widths and wrapping belong to the terminal's native API; this model computes neither.

`ReadSession` accepts `SessionOptions` and an event callback. `read({ prompt, secondaryPrompt, signal })` allows one active read. `dispatch()` processes editing commands and resolves a typed result on submission, interruption or end-of-input. Abort and disposal reject with structured errors. Completion and completeness callbacks receive an abort signal; their stale results are discarded after edits, later requests and read cancellation.

```ts
import { ReadSession } from 'ghostty-webgpu-line-editor'

const session = new ReadSession({
  complete: (text, cursor, signal) => host.complete(text, cursor, signal),
  isComplete: (text) => host.isComplete(text),
})
const pending = session.read({ prompt: '$ ', signal })
await session.dispatch({ kind: 'insert', text: 'echo hello' })
await session.dispatch({ kind: 'submit' })
const result = await pending
```

To attach the editor to a `ghostty-webgpu` terminal, load the extension and start a read when the
terminal is open:

```ts
import { Terminal } from 'ghostty-webgpu'
import { readline } from 'ghostty-webgpu-line-editor'

const terminal = await Terminal.create()
await terminal.open(container)
const editor = terminal.use(readline({ complete: completeCommand }))
const result = await editor.api.read({ prompt: '$ ' })
```

Call `editor.api.print(text)` for shell output while the prompt is active. The extension
clears and restores the prompt so output does not corrupt the line being edited.

Completion candidates are replacements for the whitespace-delimited token before the cursor. A common grapheme prefix extends that token. A second Tab at the same revision emits the candidate list. Hosts that need shell-aware quoting can implement candidate formatting in their callback.

`History` keeps the most recent 100 entries by default. Sessions may share entries and persistence; each `EditModel` owns its navigation snapshot, saved draft and reverse-search position. Navigation restores the draft after the newest entry, and Down before browsing preserves the current draft. A host can provide a `HistoryStore` with `load()` and `save(entries)`, call `history.load()` before reading, and use `history.flush()` to await saves. Snapshots passed to the store are frozen, bounded arrays. The package chooses no browser storage key.

## Verification

Build the terminal from the family root with `bun run build`, then run `bun run verify` from this directory. Tests run in Node through Vitest. From the repository root, the package is included in `build:workspaces`, workspace lint/typecheck/test commands and the Ghostty CI job.

The approved delivery work lives in [Plan 286](https://github.com/ShaulLavo/fregat/blob/main/plans/286-ghostty-extensions.md), under the root [roadmap](https://github.com/ShaulLavo/fregat/blob/main/PLAN.md).
