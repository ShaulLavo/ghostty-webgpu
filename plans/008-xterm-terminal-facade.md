# Plan 008: Implement the xterm Terminal facade and lifecycle contract

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update the parity ledger and this plan's
> status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src package.json tsconfig.build.json docs plans README.md`
> Confirm Plans 006 and 007 are DONE, the reference identity gate passes, and the live compatibility
> ledger still assigns the core Terminal rows to this plan.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 006 and 007 DONE
- **Category**: compatibility / public API / lifecycle
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

xterm consumers construct `new Terminal(options)` synchronously, inspect properties before `open`,
queue writes, subscribe to events, and expect `open(parent): void`. The native Ghostty stack is
created asynchronously. A drop-in layer therefore needs an explicit deferred-runtime architecture;
changing consumers to `await Terminal.create()` would not be compatible.

This plan establishes the compatibility facade without renaming or weakening the native
`GhosttyWebGpuTerminal` API. Later plans fill buffer/parser/browser/addon behavior through the same
facade.

## Current state

- The package root exports `GhosttyWebGpuTerminal`, whose `create` and `open` methods are async.
- It already provides write, writeln, focus, blur, paste, reset, scrolling, selection, links,
  appearance, renderer snapshots, and event subscriptions, but names and semantics differ from
  xterm.
- `TerminalSession.write` is synchronous after runtime creation; xterm `write`/`writeln` accept an
  optional callback and process writes through an ordered queue.
- There is no `Terminal` export, xterm declaration surface, addon lifecycle owner, live `options`
  object, or compatibility event shape.

## Target contract

Create a browser compatibility feature under `src/xterm/` with exact-file imports and one exported
class:

```ts
export class Terminal implements IDisposable {
  constructor(options?: ITerminalOptions & ITerminalInitOnlyOptions)
}
```

Export `Terminal` and its public xterm-compatible types from `src/index.ts`. Do not add a folder
barrel. The initial package path is the main `ghostty-webgpu` export; Plan 014 creates aliasable
compatibility packages and CSS exports.

The facade owns these states:

```text
constructed -> opening -> open -> disposing -> disposed
             \-> failed -> disposed
```

Construction is synchronous. It creates option state, event emitters, addon ownership, a FIFO
operation queue, and an asynchronous native-terminal promise. Public calls made before native
readiness are queued in call order when xterm itself permits deferred processing. Public properties
with documented immediate values read from the compatibility shadow state until the native terminal
is ready, then switch to verified live state without observable discontinuity.

`open(parent): void` must synchronously reject a second open/invalid parent as xterm does and expose
the documented DOM properties at the same observable point. It starts asynchronous GPU/runtime
attachment without returning a promise. Any async initialization failure is routed through the
configured xterm logger and an internal rejected-ready state; queued write callbacks must not be
left hanging. Do not add a required public readiness API to examples or types. An optional
Ghostty-specific diagnostic promise may be exported under a non-xterm name only if differential
tests prove it cannot affect compatibility.

Implement the released 6.0.0 behavior for these core groups in this plan:

- `element`, `screenElement`, `textarea`, `rows`, `cols`, `options`, `markers` placeholder identity,
  `modes` placeholder identity, and `dimensions` where the underlying implementation already has
  data;
- `onBell`, `onBinary`, `onCursorMove`, `onData`, `onKey`, `onLineFeed`, `onRender`,
  `onWriteParsed`, `onResize`, `onScroll`, `onSelectionChange`, `onTitleChange`, and
  `onDimensionsChange` with xterm event/disposable semantics;
- `blur`, `focus`, `input`, `resize`, `open`, `attachCustomKeyEventHandler`,
  `attachCustomWheelEventHandler`, `hasSelection`, `getSelection`, `getSelectionPosition`,
  `clearSelection`, `select`, `selectAll`, `selectLines`, `dispose`, `scrollLines`, `scrollPages`,
  `scrollToTop`, `scrollToBottom`, `scrollToLine`, `clear`, `write`, `writeln`, `paste`, `refresh`,
  `clearTextureAtlas`, `reset`, and `loadAddon`;
- every core/init option that can be mapped without Plan 009's native extension surfaces. Keep
  unsupported rows visibly `partial`; do not silently mark them compatible.

Methods assigned to Plan 009 (`buffer`, `parser`, `unicode`, full `modes`, markers, decorations,
joiners, link-provider details) may be present as stable facade objects only when needed for object
identity, but their ledger rows stay non-compatible until that plan's behavioral tests pass.

`attachCustomKeyEventHandler` has exact xterm first-refusal semantics: the latest handler is called
for DOM key events before TanStack shortcut arbitration and Ghostty encoding; returning `false`
prevents terminal processing, returning `true` continues. It does not itself prevent the browser
default. Replacing the handler replaces the previous one. Plan 006's physical-code suppression must
still prevent partial Kitty lifecycles when the handler claims a keydown.

## Commands you will need

| Purpose              | Command                                                                | Expected on success                                   |
| -------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Facade unit tests    | `bun run test:unit -- src/xterm/tests/terminal.test.ts`                | state, queue, options, events, addons pass            |
| Differential browser | `bun run test:browser -- src/xterm/tests/terminal.browser.test.ts`     | reference/target stable observables match             |
| Existing input       | `bun run test:browser -- src/dom/tests/terminal-input.browser.test.ts` | native input behavior remains intact                  |
| Declaration build    | `bun run build`                                                        | public facade declarations emit without xterm runtime |
| Parity ledger        | `bun run xterm:parity`                                                 | owned rows/evidence are current                       |
| Full gate            | `bun run verify`                                                       | repository gates pass                                 |

## Scope

**In scope**:

- `src/xterm/terminal.ts`
- `src/xterm/types.ts`
- `src/xterm/events.ts`
- `src/xterm/options.ts`
- `src/xterm/operation-queue.ts`
- additional exact `src/xterm/*.ts` modules only when one named responsibility warrants extraction
- `src/xterm/tests/terminal.test.ts`
- `src/xterm/tests/terminal.browser.test.ts`
- `src/dom/input.ts` and `src/dom/types.ts` for the Plan 006 first-refusal seam
- `src/dom/terminal.ts` for compatibility delegation and synchronous DOM shell integration
- `src/term/session.ts` for missing native operations that already exist in libghostty
- `src/index.ts`
- `package.json`
- `README.md`
- `docs/xterm-parity.json` and generated Markdown
- `plans/README.md`

**Out of scope**:

- Replacing the native Ghostty API with the compatibility class.
- Faking buffer/parser/unicode behavior from visible renderer rows.
- Publishing under `@xterm/*` or declaring zero-config package-name replacement.
- Exact CSS/DOM/accessibility option parity; Plan 010 owns it.
- Official addon implementations beyond lifecycle loading/disposal.
- Pixel-identical WebGL output.
- Suppressing initialization failures or invoking write callbacks as if failed writes parsed.

## Git workflow

- Work in the current worktree. Do not create a branch/worktree, commit, push, or open a PR unless
  requested.
- Keep compatibility changes isolated under `src/xterm/` except for narrow native seams.
- Do not import the reference implementation into production code.

## Steps

### Step 1: Add compatibility types and event primitives

Reimplement the relevant 6.0.0 public declarations from the pinned type reference with matching
names, optionality, readonly modifiers, callback types, and overloads. Do not make production types
depend on `@xterm/xterm`; use it only in compile-time comparison fixtures.

Implement `IEvent<T>` as a callable subscription property returning an idempotent `IDisposable`.
Emission iterates a listener snapshot, contains listener failures according to xterm behavior, and
does not reuse native event payload containers when xterm promises mutable/plain values.

**Verify**: type fixtures assign target `Terminal`/events/options to released xterm consumer shapes.

### Step 2: Build the deferred runtime and operation queue

Start native creation in the constructor without awaiting. Queue only operations whose xterm
contract is already asynchronous/deferred: writes, write lines, parser input, and addon activation
that waits on those surfaces. Preserve FIFO ordering across string/`Uint8Array` writes and callbacks.

Classify every public call as immediate-shadow, queued, readiness-required, or lifecycle error in a
table beside the tests. Do not return fabricated successful results for readiness-required methods.
Ensure dispose before readiness cancels attachment, disposes a late native resolution, rejects new
work, and completes/cancels queued callbacks exactly as the reference does.

**Verify**: deterministic unit tests use a deferred native factory for ordering, failure, and
disposal races.

### Step 3: Make open synchronously observable

Extract or reuse DOM element creation so `open(parent)` exposes the expected `element`,
`screenElement`, and `textarea` synchronously even if WebGPU initialization is pending. Attach the
native terminal later to that owned shell without replacing public element identities.

Opening twice, opening after dispose, disposal during GPU creation, and a failed adapter request
must match reference-observable lifecycle/error behavior. Do not block the main thread or perform
synchronous network/WASM fetches.

**Verify**: differential browser tests sample properties immediately after `open`, after one
microtask, after readiness, and after disposal.

### Step 4: Implement options and dimensions mapping

Create one normalized compatibility options store with xterm defaults and mutability rules. Map
supported values atomically to `TerminalSession`/renderer settings. Enforce init-only options and
the `allowProposedApi` gate. Option updates that trigger fit, redraw, scrollback resize, or cursor
changes must emit the same public events and ordering as the reference.

Keep every unsupported option row `partial` with a failing/skipped differential case tied to its
ledger id. No warning is a substitute for implementation, but temporary warnings may aid
development if the reference logs similarly.

### Step 5: Implement core methods and write/event ordering

Adapt native methods to xterm signatures and return values. In particular:

- `input` models user input and respects `disableStdin`/`wasUserInput` semantics;
- `resize(columns, rows)` validates and emits once in reference order;
- `write`/`writeln` accept callbacks and `Uint8Array` without retaining caller-owned mutable data;
- `clear` differs from `reset`; do not alias them without differential proof;
- scrolling uses xterm line/page semantics and clamps identically;
- selection methods use xterm 0-based buffer coordinates and exclusive/inclusive boundaries as
  documented;
- `refresh` requests the row range without inventing a standing render loop;
- `clearTextureAtlas` clears renderer cache and redraws through the existing scheduler.

Wire native session effects to all owned public events and test exact order around writes, resize,
selection, scroll, title, bell, render, and parsed callbacks.

### Step 6: Implement custom handlers and addon lifecycle

Connect the key handler to Plan 006 before shortcut/raw processing. Connect the wheel handler before
scrollbar or terminal wheel ownership and honor its boolean result. Handler exceptions must follow
reference behavior and never leave pressed/suppressed state stuck.

`loadAddon` activates once, owns disposal, rolls back failed activation, and disposes addons in the
same order as the reference. Test addon self-disposal and terminal disposal.

### Step 7: Differentially qualify and update the ledger

For each implemented row, run the same scenario against released xterm and the target. Compare
public values/events/DOM availability, not private `_core` state. Update rows to `compatible` only
when evidence passes. Keep future-plan rows honest.

Run the full gate and record counts of compatible/partial/missing/blocked rows.

## Test plan

- Pure unit tests cover deferred state, callbacks, option normalization, disposal, listener/addon
  ownership, and error races.
- Type fixtures cover consumer assignability without shipping upstream types.
- Real browser differential tests cover sync constructor/open observables and event/method ordering.
- Existing native input/renderer tests prove the facade did not change the underlying API.
- Ledger tests enforce evidence for every newly compatible row.

## Done criteria

- [ ] `new Terminal()` and `open(parent): void` work without consumer `await`.
- [ ] Pre-ready writes/callbacks preserve released xterm ordering and failure semantics.
- [ ] Core properties, events, options, lifecycle, write, scroll, selection, handler, and addon rows
      owned by this plan have differential evidence.
- [ ] `attachCustomKeyEventHandler` integrates before TanStack/raw handling without partial packets.
- [ ] Native `GhosttyWebGpuTerminal` remains exported and behaviorally intact.
- [ ] Production code has no runtime dependency on xterm.js.
- [ ] Remaining extension/browser/addon gaps stay explicit in the ledger.
- [ ] Build, parity generation, focused tests, and `bun run verify` pass.
- [ ] Plan 008 is DONE.

## STOP conditions

Stop and report if:

- A documented synchronous xterm observable cannot be provided without blocking I/O, lying about
  state, or replacing public object identities later.
- Native creation failure has no reference-compatible way to settle queued operations/callbacks.
- Implementing an option requires buffer/parser/native support assigned to Plan 009.
- A method would be marked compatible by returning a placeholder/no-op.
- The facade must import xterm runtime/private internals in production.
- Custom key/wheel handling cannot run before native ownership deterministically.

## Maintenance notes

- Compatibility state is a temporary mirror only until native readiness; keep one explicit switch
  and prove continuity.
- Additive Ghostty diagnostics must stay outside the xterm contract and never become required.
- Every public behavior change needs reference differential evidence and a ledger update.
