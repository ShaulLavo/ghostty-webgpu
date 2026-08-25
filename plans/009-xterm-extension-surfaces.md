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
- **Execution state**: BLOCKED — the public C/WASM boundary of pinned unpatched libghostty does not
  expose the required inactive-buffer, parser, Unicode-provider, row-marker, and OSC 8 identity
  surfaces

## Step 1 native capability proof — 2026-08-25

The proof used the live package pin
`c8554f28e0efe2f5595f32020371c34b25ec628f` from `src/core/version.ts`. Every source fact below
was read from that exact commit with `git show`/`git grep`, not from the newer dirty Ghostty
checkout. A direct export inspection of the checked-in `ghostty-vt.wasm` confirmed the same public
surface.

Ghostty core does implement the underlying terminal machinery: both screens, the VT parser,
compile-time Unicode tables, tracked grid pins, and OSC 8 identities all exist in Zig. This proof is
specifically about whether ghostty-webgpu can use those capabilities through the shipped public
C/WASM ABI without replacing Ghostty as the authority. An adversarial check of official Ghostty
`main` at `557253d8f64f8b08da33f5a7f3cb33a75960b09d` found no newer Plan 009 API: `src/lib_vt.zig`
and the relevant grid, tracked-ref, screen, point, snapshot, and Unicode headers are unchanged from
the pin; the only terminal ABI additions are unrelated Kitty clipboard limits.

| Target group             | Pinned native mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buffer, cells, and modes | Ghostty core owns both screens. Public access includes `ghostty_terminal_grid_ref`, `ghostty_grid_ref_{cell,row,graphemes,style,hyperlink_uri}`, `ghostty_{cell,row}_get[_multi]`, and `GHOSTTY_TERMINAL_DATA_{CURSOR_X,CURSOR_Y,TOTAL_ROWS,SCROLLBACK_ROWS,SCROLLBAR,MODE}`.                                                                                                                                                                                                                                                                                      | Cell/style data, active-screen history, and released mode reads are available. Arbitrary inactive normal/alternate reads are not exposed: point coordinates have no screen selector and the C implementation resolves terminal/grid data through `screens.active`. Pre-indexing tracked refs would be a forbidden proxy and would change native blank-row trimming. There is also no buffer-switch or semantic row-mutation callback. **STOP.** |
| Parser                   | Ghostty's internal parser covers CSI/DCS/ESC/OSC/APC, including a Zig `Stream(H).vtRaw` hook. Public terminal effects are synchronous and non-reentrant; `GHOSTTY_TERMINAL_OPT_UNKNOWN_SEQUENCE` reports only terminated unsupported APC and cannot consume it, while `ghostty_osc_*` is a standalone parser. `vtRaw` is compile-time, synchronous, fixed out of the C terminal wrapper, and receives only OSC commands recognized by Ghostty's specialized parser. The WASM exports contain no terminal-bound handler registration, Promise pause, or resume API. | Reverse handler ordering, arbitrary OSC identifiers, fallback, async return, and native parser continuation cannot be implemented through the public ABI. A pre-parser would be a forbidden second parser. **STOP.**                                                                                                                                                                                                                            |
| Unicode                  | `ghostty_unicode_codepoint_width` and `ghostty_unicode_grapheme_width` query Ghostty's fixed compile-time table. No terminal/system option registers `wcwidth` or `charProperties`; printing consults the fixed table before storing cell width, and reflow reuses stored width.                                                                                                                                                                                                                                                                                   | Providers cannot participate in authoritative native width decisions. Facade-only metadata would be false compatibility. **STOP.**                                                                                                                                                                                                                                                                                                              |
| Raw selection            | `GhosttySelection` stores valid inclusive grid references plus rectangle state; `ghostty_terminal_grid_ref` rejects out-of-range points.                                                                                                                                                                                                                                                                                                                                                                                                                           | Released reversed/out-of-range raw coordinates cannot survive in native state without a facade cache. **STOP.**                                                                                                                                                                                                                                                                                                                                 |
| Markers                  | `ghostty_terminal_grid_ref_track` and `ghostty_tracked_grid_ref_{has_value,point,set,snapshot,free}` follow cell pins across scroll, prune, resize, and reflow.                                                                                                                                                                                                                                                                                                                                                                                                    | These are cell pins, not xterm line markers. Row erase/reset may move or retain pins, and pins can prevent trailing blank-row trim; no typed insert/delete/trim/reset event exists to recover xterm disposal semantics. **STOP.**                                                                                                                                                                                                               |
| Decorations              | DOM geometry, layers, overview-ruler presentation, and scheduled rendering can live above Ghostty.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Lifetime and anchoring depend on exact marker disposal, so decorations inherit the marker stop.                                                                                                                                                                                                                                                                                                                                                 |
| Character joiners        | Native row/cell/grapheme reads and the existing multi-cell glyph span support can drive render-only grouping without changing native width or selection.                                                                                                                                                                                                                                                                                                                                                                                                           | Capability exists, but no isolated implementation is permitted after another mandatory group stops.                                                                                                                                                                                                                                                                                                                                             |
| Links                    | Ghostty stores OSC 8 identity internally, and its native HTML formatter can preserve distinct equal-URI identities within a page. Public cell inspection exposes only `ghostty_grid_ref_hyperlink_uri`; custom-provider invocation can remain a JS callback over native line snapshots.                                                                                                                                                                                                                                                                            | The public ABI exposes neither a stable identity token nor an exact native range across pages and wrapped rows. URI equality therefore cannot reproduce xterm's identity-based wrapped range expansion in every case without private-state access, a parallel parser, or shadow state. **STOP.**                                                                                                                                                |

The checked-in WASM export probe found cell/row/grid/tracked-ref/mode support, only standalone
`ghostty_osc_*` parser functions, and only the two fixed Unicode query functions. It found no
generic parser, CSI, DCS, ESC, or APC registration export.

This triggers Plan 009's explicit STOP conditions before Step 2. No bridge, source, or test
implementation was started. The bridge build, extension unit tests, browser differential, and full
verification gates are post-proof gates and were not run after the stop. The reference identity and
parity-ledger checks passed before this proof, and the ledger records this mapping without promoting
any row. Plan 009 cannot be marked DONE unless upstream exposes the missing authoritative APIs or an
operator approves an explicit parity-scope/source-revision decision.

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
