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
- **Execution state**: DONE — qualified facade/lifecycle milestone, not full xterm certification
- **Compatibility decisions**: use an upstream-only guarded visual `Terminal.clear()` instead of
  retaining xterm's cursor row or stale backing slots; abandon queued callbacks on native creation
  failure or any disposal before native consumption rather than report writes as parsed

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
write queue, and an asynchronous native-terminal promise. Public calls made before native
readiness are queued in call order when xterm itself permits deferred processing. Public properties
with documented immediate values read from the compatibility shadow state until the native terminal
is ready, then switch to verified live state without observable discontinuity.

`open(parent): void` must synchronously reject an invalid parent. Once xterm has opened
successfully, another `open` call is a no-op even after disposal: it neither throws nor moves the
terminal to a different parent. Disposing before the first open remains an explicit partial row:
released xterm creates a connected, half-initialized DOM shell, logs disposable leaks, and then
throws, while this facade rejects without leaking DOM. The first valid call exposes the documented
DOM properties at the same observable point and starts asynchronous GPU/runtime attachment without
returning a promise. Any async initialization failure is routed through the configured xterm logger
and an internal rejected-ready state; queued writes are explicitly abandoned without callbacks or
parsed events because the native parser never consumed them. Do not add a
required public readiness API to examples or types. An optional Ghostty-specific diagnostic promise
may be exported under a non-xterm name only if differential tests prove it cannot affect
compatibility.

Implement the released 6.0.0 behavior for these core groups in this plan:

- `element`, `textarea`, `rows`, `cols`, `options`, `markers` placeholder identity, and `modes`
  placeholder identity;
- `onBell`, `onBinary`, `onCursorMove`, `onData`, `onKey`, `onLineFeed`, `onRender`,
  `onWriteParsed`, `onResize`, `onScroll`, `onSelectionChange`, and `onTitleChange` with xterm
  event/disposable semantics;
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
`screenElement`, `dimensions`, and `onDimensionsChange` exist only in the pinned master reference,
not the released 6.0.0 contract, and remain forward-drift rows rather than facade requirements.

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
- `src/xterm/write-queue.ts`
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

### Step 2: Build the deferred runtime and write queue

Start native creation in the constructor without awaiting. Queue only `write`/`writeln` work whose
xterm contract is asynchronous; addon activation remains synchronous. Preserve FIFO ordering,
next-task batching, caller-owned `Uint8Array` mutation until the parse-task boundary, callback
reentrancy, and the synchronous response path after accepted user input.

Classify every public call as immediate-shadow, queued, readiness-required, or lifecycle error in a
table beside the tests. Do not return fabricated successful results for readiness-required methods.
Ensure disposal before readiness cancels attachment, disposes a late native resolution, rejects new
work, and abandons queued callbacks without inventing parse success. Disposal after readiness also
abandons any scheduled write that has not reached the native parser: released xterm can keep its
JavaScript write task alive after disposal, while this facade synchronously destroys the native
runtime. This lifecycle boundary is an accepted partial owned by Plan 015.

**Verify**: deterministic unit tests use a deferred native factory for ordering, failure, and
disposal races.

### Step 3: Make open synchronously observable

Extract or reuse DOM element creation so `open(parent)` exposes the expected `element` and
`textarea` synchronously even if WebGPU initialization is pending. Attach the native terminal later
to that owned shell without replacing public element identities.

Opening twice as a no-op, opening after dispose, disposal during GPU creation, and a failed adapter
request must match reference-observable lifecycle/error behavior. After disposal, `element` and
`textarea` retain references to their now-disconnected nodes. Do not block the main thread or
perform synchronous network/WASM fetches.

**Verify**: differential browser tests sample properties immediately after `open`, after one
microtask, after readiness, and after disposal.

### Step 4: Implement options and dimensions mapping

Create one normalized compatibility options store with xterm defaults and mutability rules. Apply
enumerable option-object properties sequentially, retaining earlier valid mutations if a later
property fails, and map each supported change transactionally to `TerminalSession`/renderer
settings. Enforce init-only options and
the `allowProposedApi` gate. Option updates that trigger fit, redraw, scrollback resize, or cursor
changes must emit the same public events and ordering as the reference.

Keep every unsupported option row `partial` with a failing/skipped differential case tied to its
ledger id. No warning is a substitute for implementation, but temporary warnings may aid
development if the reference logs similarly.

### Step 5: Implement core methods and write/event ordering

Adapt native methods to xterm signatures and return values. In particular:

- `input` models user input and respects `disableStdin`/`wasUserInput` semantics;
- `resize(columns, rows)` validates and emits once in reference order;
- `write`/`writeln` accept callbacks and retain caller-owned `Uint8Array` data only until xterm's
  scheduled parse-task boundary, then snapshot it before any readiness wait;
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

`loadAddon` wraps and owns the addon before activation. If activation throws, retain the failed
addon for terminal disposal, matching released 6.0.0. Dispose addons in reference order and test
self-disposal and terminal disposal.

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

## Execution notes

- Added the synchronous `Terminal` facade, stable pre-ready option/dimension state, asynchronous
  native runtime attachment, xterm-shaped events/types, addon ownership, selection adapters, custom
  key/wheel first refusal, fixed-grid renderer attachment, and retained disconnected DOM identities.
- Replaced the generic deferred-operation queue with `XtermWriteQueue`. Successful writes now match
  released task-boundary batching, caller-owned `Uint8Array` mutation through the scheduled parse
  task and later time slices, callback-reentrant writes, append-to-remainder behavior between slices,
  separate `writeln` payload/CRLF entries, the accepted-user-input synchronous response path both at
  top level and recursively inside `onWriteParsed`, parsed-event batching, and the pending-data
  watermark. Bytes are copied only when the parse task actually encounters a native-readiness block.
  Nested fast-path callback failures strand the queue before the event sink can swallow them, and a
  yielded nested remainder resumes only in its scheduled slice.
- Native creation failure or disposal calls `abandon()`: callbacks and `onWriteParsed` events for
  writes not yet consumed by the native parser are not fabricated, while initialization failure
  rejects `ghosttyReady` diagnostically. This is an accepted lifecycle divergence and remains
  explicitly `partial` under Plan 015.
- Event delivery drains the outer listener snapshot before recursive emission, ignores listener
  return values without assimilating thenables, continues after synchronous listener failures, and
  reports those failures through the browser's unexpected-error path rather than the terminal
  logger. The default path suppresses only xterm's exact `Canceled` error. Custom key/wheel decisions
  are evaluated per dispatch, and the synchronous shell retains ownership until native key and wheel
  listeners are installed, even while renderer creation is pending.
- Addons activate synchronously, may self-dispose, remain owned after failed activation, dispose in
  reverse load order, retain ownership when wrapping a non-writable `dispose` fails, and propagate
  the first disposal failure after core teardown. Loading an addon or replacing a custom handler
  after disposal follows released behavior.
- Option-object assignment is sequential and retains earlier valid changes when a later property
  fails. Released sanitizer behavior for `undefined` and non-finite values and the fresh
  `Terminal.strings` accessor identity are covered by focused tests. Direct and bulk option changes
  remain observable after disposal without touching the destroyed native runtime.
- Synchronous `open()` installs the textarea/focus shell before asynchronous native/GPU attachment;
  the write queue pauses during host attachment and resumes afterward. Differential browser evidence
  now covers focus reporting inside pre-ready write callbacks as well as ready focus/blur behavior.
  Due pre-ready callbacks drain in their own task, so an exception strands the batch without rejecting
  native initialization or `open()`.
- Focused clear evidence reports 80 unit tests passing across the core ABI/runtime, session, and
  facade suites, plus a 25-pass/1-skip released-xterm browser differential. The final repository
  gate passes 237 unit tests and 113 browser tests with one intentional skip, then completes the
  declaration build, reference-package check, and packed-consumer smoke test.
- A clean-clone `bun run build:wasm -- --zig
/Users/shaul/Desktop/D/ghostty-webgpu-spike/ghostty/toolchain/zig` checked out immutable official
  Ghostty commit `c8554f28e0efe2f5595f32020371c34b25ec628f` without patches. The resulting
  `ghostty-vt.wasm` is 772,977 bytes with SHA-256
  `dfb171587bc11b6610fb95d3b583926d51287f5d6e528c45ff2aa05218608a97`; it exports
  `ghostty_terminal_get` and `ghostty_terminal_vt_write` and does not export the fork-only
  `ghostty_terminal_clear`. `bridge.wasm` is 577 bytes with SHA-256
  `47fae389c94f2545b2026d756256272b65f978d97feabae21b9171ad4b54b63f`.
- `build:wasm -- --source` now rejects tracked or untracked source changes before compiling, so a
  dirty checkout cannot be labeled as the immutable pin. A fresh remote clone still reproduces the
  hashes above.
- The 172 unresolved rows formerly owned by Plan 008 were transferred without promotion: 25 native
  extension rows to Plan 009, 113 browser/DOM rows to Plan 010, nine package/addon declaration rows
  to Plan 014, and 25 certification/policy rows to Plan 015. Those rows were 171 `partial` rows and
  the `blocked` clear row. Plan 008 now owns 13 `compatible` rows and no `missing`, `partial`, or
  `blocked` rows.
- Raw selection, exact input/paste strings, renderer damage ranges, `onBinary`, constructor and DOM
  boundary cases, and the remaining option/event matrix stay explicitly partial under their
  follow-on owners. Stable fail-loud Plan 009 placeholders are not implementations.
- `Terminal.clear()` now uses only APIs and VT behavior in that official pin. It queries
  `GHOSTTY_TERMINAL_DATA_VT_GROUND` through `ghostty_terminal_get`; a non-ground parser throws
  synchronously before content, selection, revision, or events change. From ground it writes
  `CSI 22 J + CSI 3 J + CUP`. Ghostty's upstream `CSI 22 J` moves every non-empty active row,
  including ISO-protected cells, into history; following `CSI 3 J` removes that history. The sequence
  keeps parser, title, modes, and rendition state, while CUP resolves VT home under the current
  origin mode and margins.
- The core operation explicitly clears native selection after the VT write. The session then resets
  selection gesture state, emits one selection notification when needed, emits scroll zero when
  clearing history or a lower cursor row, and always requests a render. A successful post-ready
  clear is therefore never the released-xterm top-row no-op.
- Browser differential evidence records the policy directly. Released xterm retains `keep!` as row
  zero while keeping a now-empty raw row-one selection with no selection notification; this facade
  produces a blank row, no selection coordinates, and one notification. In the cursor-origin case,
  released xterm retains `lower` and true-no-ops while this facade blanks it and clears selection.
- No retained target row means the old stale-slot alias and outgoing-wrap experiments are no longer
  target behavior. Reproducing those xterm internals would still require a shadow terminal or a
  foundational native row-identity refactor, neither of which is maintained.
- Released xterm also disposes every marker on the active buffer synchronously before compaction,
  while Plan 009 still owns the native marker surface.

## Accepted divergence: visual hard clear

Plan 008 intentionally does not reproduce released `@xterm/xterm@6.0.0` row retention or access to
logically discarded backing slots. A ready terminal instead performs one guarded visual operation:

1. Query official `GHOSTTY_TERMINAL_DATA_VT_GROUND` and throw without mutation unless true.
2. Insert `CSI 22 J + CSI 3 J + CUP` through official `ghostty_terminal_vt_write`.
3. Clear native selection and selection-gesture state.
4. Publish the resulting selection/scroll changes and request a render.

This blanks ordinary and ISO-protected active cells by moving them into history before deleting
history, clears pending wrap, preserves parser/title/modes/rendition state, and positions the cursor
at VT home. VT home follows the current origin mode and margins; this operation does not reset them.
The pre-ready facade call remains a synchronous no-op because no native parser exists yet.

The accepted differences are:

- released xterm retains the cursor row, while this facade removes every active row;
- released xterm can true-no-op at cursor origin, while a ready facade always executes and redraws;
- released xterm can retain raw selections without notifying, while this facade clears them and
  emits one selection change;
- discarded rows and live row zero are never stale aliases because no row is retained;
- a non-ground parser makes this facade throw synchronously rather than inject bytes into an OSC,
  CSI, ESC, DCS, APC, or partial UTF-8 sequence.

Reproducing xterm's stale row identities safely would require a foundational native row-identity
refactor or facade-side retained state. A selected-text snapshot, detached-row cache, or facade-side
buffer would be a shadow terminal and remains forbidden. The released-xterm differential cases are
executable documentation. `Terminal.clear` stays `partial`, not `compatible`, and this divergence
no longer blocks Plan 008. Revisit it only through an explicit compatibility-policy decision; do
not quietly add retained state or weaken the ledger.

## Qualified completion policy

Plan 008 is complete as the synchronous facade and lifecycle milestone without claiming complete
released-xterm compatibility. `DONE` for this plan means that the implemented contract and every
known gap have current evidence and an explicit follow-on owner; it does not turn a `partial` ledger
row into a `compatible` one. Plan 015 remains the certification gate for full released-package
parity.

The following outcomes are accepted for the asynchronous native/write lifecycle boundary:

- successful pre-ready `write` and `writeln` calls retain FIFO processing and callback order;
- native creation failure rejects the Ghostty-specific `ghosttyReady` diagnostic promise;
- disposal before native readiness cancels attachment and disposes any late native resolution;
- native creation failure or disposal at any lifecycle point abandons writes not yet consumed by
  the native parser instead of invoking their callbacks as though parsing succeeded.

Released xterm has no asynchronous native-construction phase and can leave its JavaScript parser
task alive after disposal. This facade destroys the native runtime synchronously, so it cannot
honestly settle an unconsumed write afterward. Adding a synthetic success callback would lie about
parsing, while a new public error callback would change the xterm API. `Terminal.write`,
`Terminal.writeln`, `Terminal.onWriteParsed`, and `Terminal.dispose` consequently remain `partial`
under Plan 015. `Terminal.input` remains `partial` under Plan 010 for its separate exact-string
delivery seam. `ghosttyReady` is diagnostic only and must not become required consumer control flow.

The following rows also remain explicitly partial until their named lower-level dependency exists:

- raw, reversed, and out-of-range selection coordinates require a native selection representation
  that is not restricted to currently addressable PageList rows; facade-side selected text or row
  state is forbidden;
- exact `input` and `paste` strings require a native/facade delivery seam that separates xterm's JS
  string event from Ghostty's UTF-8 and safe-paste encoding, plus a native bracketed-paste mode
  query;
- exact `onRender`, `refresh`, and `clearTextureAtlas` ranges require renderer frame metadata for
  the rows damaged in the current frame rather than inference from the full cached frame snapshot;
- focus/blur now attach through the synchronous DOM shell before GPU readiness; the remaining
  browser-wide interaction matrix is owned by Plan 010;
- `onBinary` requires a native binary-output channel distinct from ordinary UTF-8 `onData`;
- `buffer`, `parser`, `unicode`, full `modes`, and markers require the native-backed extension and
  C-ABI surfaces owned by Plan 009; their stable fail-loud placeholders are not implementations.

These are qualification boundaries, not permission to mark placeholders compatible. Differential
tests and ledger notes must continue to expose every difference. The parity validator was preserved:
all 172 unresolved Plan 008 rows moved to their concrete follow-on owners, so this DONE plan owns no
gap. No row was promoted to satisfy the gate.

Plan 015 now owns the accepted clear and asynchronous-write-lifecycle divergences. Its current
zero-gap done criterion cannot pass while those rows remain `partial`, and the clear divergence is
operator-approved rather than standards-backed. Plan 015 must therefore remain open unless exact
behavior is implemented or its final compatibility claim receives a separate explicit policy
decision. Plan 008 completion does not pre-authorize that decision or weaken the validator.

## Finalization sequence

The Plan 008 closure performed these steps:

1. recorded the focused unit/browser verification from the implementation passes;
2. regenerated and validated the parity documents against the checked-in WASM provenance;
3. reconciled the execution notes and ledger counts with those results;
4. transferred every remaining partial row to its concrete follow-on owner; and
5. changed this plan and the status table in `plans/README.md` to `DONE` only after the parity
   validator accepted the new ownership.

## Done criteria

- [x] `new Terminal()` and `open(parent): void` work without consumer `await`.
- [x] Successful pre-ready writes preserve FIFO ordering; abandonment of unconsumed writes on
      native failure or disposal is documented and remains `partial`.
- [x] Core properties, events, options, lifecycle, write, scroll, selection, handler, and addon rows
      have current evidence or a concrete partial dependency in the ledger.
- [x] `attachCustomKeyEventHandler` integrates before TanStack/raw handling without partial packets.
- [x] Native `GhosttyWebGpuTerminal` remains exported and behaviorally intact.
- [x] Production code has no runtime dependency on xterm.js.
- [x] The guarded visual-hard-clear `Terminal.clear()` divergence is documented and remains
      `partial` in the ledger.
- [x] Native-failure callbacks, raw selection, exact input/paste, render ranges, remaining browser
      focus behavior, `onBinary`, and Plan 009 extension dependencies remain explicit and
      non-compatible.
- [x] Remaining extension/browser/addon gaps stay explicit in the ledger.
- [x] Focused implementation tests are recorded above; parity generation and validation pass.
- [x] The parity validator accepts Plan 008 as DONE with 13 compatible rows and no owned gaps.
- [x] Plan 008 is DONE.

## STOP conditions

Stop and report if:

- A documented synchronous xterm observable cannot be provided without blocking I/O, lying about
  state, or replacing public object identities later.
- A failure path invokes queued callbacks as if their writes parsed successfully.
- Implementing an option requires buffer/parser/native support assigned to Plan 009.
- A method would be marked compatible by returning a placeholder/no-op.
- The facade must import xterm runtime/private internals in production.
- Custom key/wheel handling cannot run before native ownership deterministically.

## Maintenance notes

- Compatibility state is a temporary mirror only until native readiness; keep one explicit switch
  and prove continuity.
- Additive Ghostty diagnostics must stay outside the xterm contract and never become required.
- Every public behavior change needs reference differential evidence and a ledger update.
