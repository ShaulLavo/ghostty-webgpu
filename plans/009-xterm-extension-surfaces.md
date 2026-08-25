# Plan 009: Expose xterm buffer, parser, Unicode, marker, decoration, and joiner surfaces

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update the parity ledger and this plan's
> status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- scripts/bridge.zig src/core src/term src/render src/xterm docs plans`
> Confirm Plans 007–008 are DONE and regenerate the ledger before touching the native bridge. Verify
> every required capability against the live pinned libghostty API; visible render rows are not a
> substitute for buffer/parser state.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plan 008 DONE
- **Category**: native bridge / compatibility / extensibility
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

Much of the xterm ecosystem is built on live buffer inspection and parser registration, not merely
the `Terminal` method names. Search, serialize, progress, clipboard, image protocols, decorations,
markers, Unicode providers, and third-party addons all depend on these surfaces. Faking them from the
last visible WebGPU frame would omit scrollback, inactive buffers, parser ordering, and native width
decisions.

This plan adds only native-backed, semantically live adapters. If pinned unpatched libghostty cannot
expose a required capability, mark it blocked and stop for an upstream decision instead of shipping
a divergent shadow terminal.

## Target contract

Implement the 6.0.0 public behavior and stable object identity for:

- `Terminal.buffer`: `active`, `normal`, `alternate`, `onBufferChange`;
- `IBuffer`: type, cursorX/Y, viewportY, baseY, length, `getLine`, `getNullCell`;
- `IBufferLine`: wrapping, length, `getCell`, `translateToString`;
- `IBufferCell`: chars/code/width, foreground/background modes and values, every style/underline
  query, default-attribute query, and attribute equality;
- `Terminal.modes`: every released boolean/mouse-tracking mode;
- `Terminal.parser`: CSI, DCS, ESC, OSC, and APC handler registration/disposal, fallback ordering,
  parameter arrays, async return behavior, and proposed-API enforcement;
- `Terminal.unicode`: provider registration, version list, active version, width/properties behavior;
- `markers`, `registerMarker`, and marker disposal/line movement;
- `registerDecoration`, render elements, overview-ruler options, layers, anchoring, mutation, and
  disposal;
- `registerCharacterJoiner`/`deregisterCharacterJoiner` with renderer integration;
- exact `registerLinkProvider` public ranges, callbacks, decorations, disposal, and precedence.
- raw selection coordinates and events for `clearSelection`, `getSelection`,
  `getSelectionPosition`, `hasSelection`, `onSelectionChange`, `select`, `selectAll`, and
  `selectLines`, including reversed and out-of-range public coordinates without a facade row cache.

Plan 009 also owns the 25 transferred Plan 008 partial rows whose exact behavior depends on these
native surfaces: `IDisposableWithEvent*`, `IFunctionIdentifier*`, `IWindowsPty*`, the
`allowProposedApi`, `linkHandler`, `reflowCursorLine`, `scrollback`, `scrollOnEraseInDisplay`,
`tabStopWidth`, and `windowsPty` options; `Terminal.buffer`, `Terminal.markers`, `Terminal.modes`,
`Terminal.parser`, and `Terminal.unicode`; plus the three raw selection mutators. None became
compatible during transfer.

Native truth remains authoritative. Add bridge ABI operations in `scripts/bridge.zig` and typed
wrappers in `src/core/` only where pinned libghostty exposes the needed state/hooks. The checked-in
Ghostty WASM must still be produced directly from the exact pinned source revision without
build-time patches.

## Commands you will need

| Purpose              | Command                                                              | Expected on success                              |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| Rebuild bridge       | `bun run build:bridge`                                               | bridge ABI/types regenerate cleanly              |
| Rebuild pinned WASM  | `bun run build:wasm`                                                 | only if the pinned source revision/API changes   |
| Core extension tests | `bun run test:unit -- src/core/tests/xterm-surfaces.test.ts`         | native reads/hooks/ownership pass                |
| Facade unit tests    | `bun run test:unit -- src/xterm/tests/extensions.test.ts`            | stable adapters and parser ordering pass         |
| Differential browser | `bun run test:browser -- src/xterm/tests/extensions.browser.test.ts` | buffer/decorations/joiners/links match reference |
| Parity ledger        | `bun run xterm:parity`                                               | owned rows all carry evidence                    |
| Full gate            | `bun run verify`                                                     | repository gates pass                            |

## Scope

**In scope**:

- `scripts/bridge.zig`
- `src/core/abi.ts`
- `src/core/bridge.ts`
- `src/core/terminal.ts`
- `src/core/types.ts`
- focused `src/core/buffer.ts` and `src/core/parser.ts` modules if needed
- `src/core/tests/xterm-surfaces.test.ts`
- `src/core/selection.ts` and its focused tests for raw compatibility coordinates
- `src/term/session.ts`
- `src/term/types.ts`
- `src/render/renderer.ts` and glyph layout only for decorations/joiner consumption
- `src/xterm/terminal.ts`
- `src/xterm/types.ts`
- focused buffer/parser/unicode/marker/decoration adapters under `src/xterm/`
- `src/xterm/tests/extensions.test.ts`
- `src/xterm/tests/extensions.browser.test.ts`
- `src/index.ts`
- `THIRD_PARTY_NOTICES.md` only if source adaptation requires it
- parity docs and `plans/README.md`

**Out of scope**:

- Maintaining a second JavaScript VT parser or shadow scrollback buffer.
- Patching vendored Ghostty source or checking in an unreviewed fork.
- Addon-specific search/serialize/image behavior; later plans consume these primitives.
- DOM option/input/accessibility parity outside decoration/joiner rendering.
- Treating internal xterm `_core` services as public API.
- Changing Ghostty's width/continuation decisions without a deliberate Unicode provider contract.

## Git workflow

- Work in the current worktree; do not branch, commit, push, or open a PR unless requested.
- Build the bridge from source and review generated WASM diffs. Never hand-edit generated WASM.
- Any source revision bump is a separate explicit decision with provenance and full VT regression.

## Steps

### Step 1: Perform a native capability proof before implementation

For every target group, name the exact pinned libghostty API or callback that can provide it. Prove
arbitrary normal/alternate/scrollback row access, cell attributes, cursor/base/viewport positions,
mode reads, parser handler interception, Unicode width override, and mutation notifications.

Record the mapping in the parity ledger. If parser callbacks or Unicode providers cannot participate
inside Ghostty at the same point as native parsing/width decisions, STOP. Do not proceed with a
parallel JS parser/provider that can disagree with rendered/native state.

### Step 2: Extend the typed bridge with borrowed read scopes

Add minimal bridge operations for arbitrary buffer/line/cell snapshots and modes. Define explicit
ownership: native pointers do not escape a read scope, JS wrappers copy scalar/text values, and live
namespace/buffer objects resolve current state on each access. Do not allocate a full scrollback copy
for one `getLine` call.

Make readonly/mutable contracts reflect actual mutation. Add ABI layout/version checks so stale
bridge/WASM combinations fail during initialization rather than corrupting reads.

**Verify**: core tests cover empty lines, wide/continuation cells, combining text, RGB/palette/default
colors, every style, normal/alternate switches, scrollback, resize/reflow, and disposal.

### Step 3: Implement stable buffer and modes adapters

Create stable `buffer`, `normal`, `alternate`, and `modes` object identities at facade construction.
Their getters query current native state after readiness and use verified initial shadow values before
readiness. `active` changes identity between the two stable buffer objects and fires one
`onBufferChange` event in reference order.

`IBufferLine.getCell(x, reusable?)` honors the reusable cell contract without retaining a line
pointer. `translateToString` matches trim and column-range semantics for blanks, combining, wide,
and wrapped rows.

### Step 4: Add parser registration at the native parse boundary

Expose handler registration tokens through the bridge for CSI/DCS/ESC/OSC/APC. Preserve xterm's
reverse registration/fallback order, `boolean | Promise<boolean>` meaning, parameter nesting,
sequence size limits, and idempotent disposal.

Pause only the affected parser continuation when awaiting an async handler; preserve FIFO writes and
`onWriteParsed` timing without reentrant session mutations. Handler exceptions/rejections fall
through or surface exactly as the reference does.

Gate proposed handlers through `allowProposedApi` at access/registration time.

### Step 5: Add Unicode provider integration

Register/version providers in the facade and bridge their `wcwidth`/`charProperties` decisions into
the native parser before cells are created. Switching `activeVersion` affects subsequent parsing in
the same cases as xterm and triggers the required reflow/redraw behavior.

If libghostty intentionally owns a non-replaceable Unicode table, STOP and propose either an upstream
pluggable-width API or an explicit parity-scope change. Do not report facade-only version metadata as
compatible.

### Step 6: Implement markers and decorations on native buffer coordinates

Markers attach to the active buffer line with reference-compatible cursor offsets, update through
insert/delete/trim/reflow, and dispose when their line leaves the buffer. Decorations subscribe to
markers, create DOM elements lazily on render, apply range/layer/overview semantics, and dispose
idempotently.

Keep decoration geometry event-driven and within the existing scheduler. No permanent animation or
DOM scan loop.

### Step 7: Implement joiners and public link providers

Run character joiners on logical rendered line text, translate returned UTF-16 ranges to cell spans,
and feed spans into glyph rasterization without changing native cell width or selection text. Cache
by line revision/joiner generation and invalidate only affected rows.

Adapt existing native OSC 8/provider/built-in URL precedence to exact xterm `ILinkProvider` ranges
and lifecycle. Keep the project security rule: activation requires the handler and validates unsafe
protocol behavior according to the xterm option contract.

### Step 8: Differentially certify every extension row

Drive identical VT streams and registrations through released xterm and the target. Compare public
buffer/cell values, event order, handler fallthrough, Unicode widths, marker movement/disposal,
decoration elements, joined ranges, and link callbacks.

Update only passing rows to `compatible`, run the full gate, and record bridge ABI/source revisions.

## Test plan

- Core tests exercise native state without DOM.
- Differential unit tests cover pure facade identity, buffer values, modes, parser, and Unicode.
- Browser tests cover decoration elements, joiner raster integration, and links.
- Fuzz/property fixtures feed chunked sequences and compare handler/buffer outcomes across engines.
- ABI mismatch and disposed-pointer tests fail safely.
- Existing renderer benchmarks confirm no full-scrollback copy or standing work was introduced.

## Done criteria

- [ ] Native capability mapping exists for every owned row with no JS shadow parser/buffer.
- [ ] Buffer/cell/modes adapters match 6.0.0 values and stable identities.
- [ ] Parser handlers match registration, fallback, async, disposal, and write-order semantics.
- [ ] Unicode providers affect actual native width decisions.
- [ ] Markers track native buffer mutations and decorations render/dispose correctly.
- [ ] Character joiners and link providers match public ranges/lifecycle without corrupting cells.
- [ ] Bridge ABI is versioned, ownership-safe, rebuilt, and tested.
- [ ] All owned ledger rows are compatible with evidence.
- [ ] Focused tests, benchmarks where relevant, and `bun run verify` pass.
- [ ] Plan 009 is DONE.

## STOP conditions

Stop and report if:

- Pinned unpatched libghostty lacks arbitrary buffer access, parser interception, or Unicode provider
  integration required for exact behavior.
- The only proposed implementation is a second JS parser, shadow scrollback, or visible-frame proxy.
- Async parser handlers would reorder writes or require unsafe session reentry.
- Marker/decoration tracking cannot survive native trim/reflow with exact coordinates.
- Joiners require changing native width/selection semantics rather than render-only grouping.
- Bridge pointer ownership or ABI compatibility cannot be made explicit and testable.
- An upstream Ghostty fork/patch would be required without operator approval.

## Maintenance notes

- Live public objects may be stable while their data is queried on demand; never retain borrowed
  native row/cell pointers.
- Parser and Unicode extension points must participate in the authoritative native state machine.
- Any libghostty revision bump reruns the entire differential corpus, not only bridge unit tests.
