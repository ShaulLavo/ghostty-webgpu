# Coherent live and displayed publication (X7)

Status: Approved research. Plan item X7 in `.internal/reference-study-2026-10/next-steps.md`.
Base: PR #9 head `b246eea93` (one shared render state per terminal). Prototype: branch
`research/coherent-publication`. Decision: see [Decision](#decision).

## Question

The viewport exists in many representations. Each one serves a real requirement, but nobody owns
the whole set (study lane 01, weakest point 2, sections 13 to 16). This note answers three
questions. Which representations exist, who writes and reads them, and what do they cost? Can one
owner hold viewport state, with every other view derived on demand by row identity? And does the
highest-value slice of that design pay for itself on hardware?

## Inventory

Sizes are per terminal at 200×50 (N = 10,000 cells, R = 50 rows), wasm32. Struct sizes come from
`@sizeOf` in the pinned build. Citations are at `b246eea93` unless marked.

| #   | Representation                                    | Where                                                                                                                                                               | Writer, when                                                                                                                                                                 | Readers                                                                                                                           | Size                                                                                       | Requirement                                                                      |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | Upstream render-state projection                  | core wasm; `src/core/render-state.ts:163`, update at `:368`; upstream `src/terminal/render.zig:402`                                                                 | `SharedRenderState.captureUpdate`, each frame with damage; copies dirty rows, all rows on a viewport pin change                                                              | Bridge frame builder, row readers, displayed capture                                                                              | ≈32 B/cell (raw 8, grapheme slice 8, `Style`) plus row arenas, ≈320 KB                     | Parse-isolated snapshot with damage and row identity. Upstream-owned (ADR 001).  |
| 2   | Bridge row cache                                  | `scripts/bridge.zig:212` (`CachedCell` 40 B), `:222` (`RenderedCell` 24 B), `:237` (`FrameCache`)                                                                   | `bridge_build_frame`, rows it writes                                                                                                                                         | Bridge only: row matching (`:394`), unchanged-cell reuse (`:727`)                                                                 | 64 B/cell + 2×80 B/row ≈ 650 KB                                                            | Reuse GPU records for unchanged or moved rows                                    |
| 3   | Live GPU records                                  | `scripts/bridge.zig:175`; allocated `src/core/zig-frame.ts:61-62`                                                                                                   | `bridge_build_frame`, written cells                                                                                                                                          | Upload (`src/render/webgpu/text-pass.ts:141`, `src/render/webgl/text-pass.ts:357`)                                                | 160 B/cell = 1.6 MB                                                                        | Upload source for dirty spans                                                    |
| 4   | Scratch GPU records                               | `FrameCache.cells/glyphs`; full copy at `scripts/bridge.zig:382-383`                                                                                                | Planning, when rows moved and forward streaming is unsafe                                                                                                                    | `reuseFrameRow` (`:488`)                                                                                                          | 160 B/cell = 1.6 MB, always allocated                                                      | Source for non-streaming row moves                                               |
| 5   | GPU instance buffers                              | WebGPU storage / WebGL2 attributes                                                                                                                                  | Dirty-span uploads                                                                                                                                                           | Shaders                                                                                                                           | 160 B/cell = 1.6 MB of GPU memory                                                          | Drawing (ADR 002)                                                                |
| 6   | Native displayed slots (current, previous, spare) | `scripts/retained-frame.zig:13`, `src/core/displayed-frame.ts:114`                                                                                                  | `retainFrame`, every submitted frame of the DOM host (`src/render/shared/frame-observer.ts:97`); dirty rows captured, rows whose slot lags copied (`retained-frame.zig:167`) | Lazy text and styled reads for `visibleLines`, accessibility, `onText`, links, `frameSnapshot` (`src/dom/execution-local.ts:377`) | 3 × (28 B/cell + 24 B/row) ≈ 840 KB                                                        | What the user sees, readable after live state moves on, including DEC 2026 holds |
| 7   | Snapshot reader scratch                           | `src/core/snapshot-reader.ts:98`; five readers: live paint and text (`render-state.ts:170`), displayed paint, text and previous text (`displayed-frame.ts:123-127`) | Each read                                                                                                                                                                    | Copied into JS immediately                                                                                                        | 24 + 12 + 24 + 12 + 12 = 84 B/cell ≈ 840 KB once all are used                              | Borrowed wasm views for one read                                                 |
| 8   | JS paint rows                                     | `src/core/row-reader.ts:27` (`records.slice()`)                                                                                                                     | Canvas and DOM paint (`row-renderer.ts:306`), `onRowsPainted` / `onFrame` (`webgpu/renderer.ts:539,570`)                                                                     | Painters, frame observers                                                                                                         | 24 B/cell per read, plus lazily materialized cells                                         | Styled paint input for non-GPU backends and full-row observers                   |
| 9   | Frame observer row cache, y-indexed               | `src/render/shared/frame-observer.ts:30-31`                                                                                                                         | Every frame with text observers: re-reads changed rows from live state (`:94`, `:196`)                                                                                       | `onFrame`, `onTextFrame`, displayed text frames                                                                                   | One frozen text row per row; text + lazy cell arrays                                       | Owned rows that outlive the next native update                                   |
| 10  | Previous displayed text, re-extracted             | `frame-observer.ts:93` and `execution-local.ts:485`, read through `displayed-frame.ts:16`                                                                           | Every frame with text observers; every lazy summary read                                                                                                                     | `submittedFrame` diff (`src/dom/submitted-frame.ts:113`)                                                                          | Full viewport text per frame                                                               | `rowPatches`: rows whose text changed since the previous submitted frame         |
| 11  | Submitted summary rows                            | `src/dom/submitted-frame.ts:98`                                                                                                                                     | Each submission, lazily in retained mode                                                                                                                                     | `visibleLines` (`src/dom/terminal.ts:750`), `onText`, accessibility (`terminal.ts:1281`)                                          | `{ y, text }` per row, shared when unchanged                                               | Public submitted-frame contract                                                  |
| 12  | Consumer projections                              | Link cells (`src/dom/links.ts:130`, `src/term/link-snapshot.ts:53`), accessibility mirror DOM, DOM renderer spans                                                   | Their consumers                                                                                                                                                              | Link resolution, screen readers, DOM layout                                                                                       | Consumer-sized                                                                             | Consumer-specific shapes                                                         |
| 13  | Worker publication graph                          | `src/worker/runtime.ts:252` (`needsFrameRows: () => true`), `:379`; host freeze `src/worker/execution.ts:285`                                                       | Every worker frame, with or without host observers                                                                                                                           | Host `visibleLines`, links, accessibility, `submittedFrame`                                                                       | Structured clone of summary rows plus every projection row's text, cells and continuations | Host-side reads without a native session                                         |

Counting only representations that hold viewport content: the main entry on a GPU backend keeps
rows 1 to 7 resident. With text observers (links, `onText`) it adds rows 9 to 11, and it rebuilds
row 10 every frame. The worker entry has all of these inside the worker, and row 13 on top.

### Copies per frame

| Path                                           | Copies per submitted frame, before                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main entry, no text observers (default)        | Upstream projection of dirty rows; bridge build; GPU upload; native displayed capture of dirty rows plus lagging-slot rows. Text is read only when someone asks.                              |
| Main entry, text observers on                  | The above, plus a live text read of every changed row (row 9), plus a full re-read of the previous native frame's text (row 10), plus a text compare of every row for `rowPatches`.           |
| Main entry, accessibility on, no text observer | Every 100 ms: a full text read of the current native frame and a full text read of the previous one.                                                                                          |
| Worker entry                                   | As "text observers on" inside the worker, without the native capture; then a structured clone of all projection rows with all cell arrays, plus summary rows, then a deep freeze on the host. |

Measured in Node on the real wasm (`.internal/coherent-publication/ops.ts`), 200×50, one terminal:
a native capture of 50 dirty rows costs 0.034 ms. A live text read of 50 rows costs 0.10 ms
(0.19 ms with wide and combining text). A text read of a native slot costs 0.067 ms (0.13 ms). With
text observers on, the publication step costs 0.23 ms per frame, against 0.03 ms without them.
About three quarters of that is the two redundant text extractions.

## Design

**One owner.** After #9 each terminal has one `SharedRenderState`. It owns the upstream projection
(row 1) and should own the displayed viewport too: one `DisplayedFrameStore`, holding native rows
retained per accepted submission (row 6), plus one text cache keyed by row identity. Subscriptions
(renderers) receive displayed tokens, not copies. #11's native clean acknowledgement runs on the
shared state and doesn't interact with this.

**Identity.** Each retained row records its upstream row id (`GHOSTTY_RENDER_STATE_ROW_DATA_ID`,
which upstream documents as stable "across updates" for renderer caches). It also records a _text
revision_. A recaptured row inherits the text revision of the baseline row with the same id when
its cells match on everything except style bits and its graphemes are equal; otherwise it gets a
fresh revision. Equal revision therefore implies equal text, cells and continuation flags, at any
`y`. This is xterm.js master's per-line string cache with mutation invalidation, except that
invalidation comes from native comparison rather than JS mutation hooks.

**Derived views, produced on demand.**

| View                                                                              | Derived from                                                                                                                                            | Output unchanged because                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Text rows (`visibleLines`, `onText`, links, accessibility, displayed text frames) | Text cache by revision. Misses read only those rows from the native slot. A hit at a new `y` re-wraps the row object, sharing its text and lazy arrays. | Same reader, same native cells; equality is checked natively before a revision is shared               |
| Previous text for `rowPatches`                                                    | The same cache, read through the previous slot's revisions                                                                                              | `submittedFrame` still compares text per row, so a style-only change still produces no patch           |
| Styled rows (`frameSnapshot`, `onFrame` `renderCells`)                            | Native slot `readRows`, lazily                                                                                                                          | Unchanged path                                                                                         |
| DEC 2026 holds                                                                    | No capture while held (`SharedRenderState.update` returns early); the held frame's token stays current                                                  | Unchanged path                                                                                         |
| Worker publication                                                                | Ordered list of text revisions per frame, plus rows for revisions the host doesn't have                                                                 | The host keeps the same revision-keyed cache and rebuilds rows and the summary with the same functions |

**What stays separate, and why.** Rows 1 to 5 stay. The upstream projection is upstream's
(ADR 001). The bridge cache, live records and GPU buffers are the instanced renderer's state
(ADR 002), and they key by the same upstream row ids already. Scratch records (row 4) can go only
with X5 (compact records) or X6 (a general row map), which own that question. Row 8 (styled paint
rows) serves Canvas and DOM painting, a different requirement from text.

**What goes.** The frame observer's y-indexed text cache (row 9) for retained consumers, the
per-frame previous-text re-extraction (row 10) and its reader scratch, the live text read on the
observer path, and, in the worker, the full-graph clone (row 13), replaced by revision patches. A
later step can drop the previous native slot (6) to two slots: once text has revisions, the
previous frame needs only its revision list, with its rows pinned in the cache.

## Prototype

Two commits on `research/coherent-publication`:

1. `b3872fc41`: the retained frame exports per-row revisions (`bridge_read_retained_revisions`).
   `DisplayedFrameStore` memoizes text rows by revision across current and previous frames. The
   frame observer takes its text rows from the retained frame when it has one and no `onFrame`
   listener. The previous-text reader is gone.
2. `e0c538a1b`: retained rows record the upstream row id and a text revision that follows identity
   while text is equal (`scripts/retained-frame.zig`, `textRevision`). The JS cache keys on the
   text revision alone. Identity matching costs one row compare per captured row, so it starts only
   after the first displayed-text read; until then each captured row gets a fresh revision.

The worker slice is not prototyped. X4 owns worker publication as binary row deltas
(`research/worker-pool`). X7's contribution there is the patch key: publish by text revision so a
one-line scroll sends one row, not fifty.

Equivalence: `src/core/tests/coherent-publication.test.ts` drives the real wasm through dense
redraws, scrolls with wide, combining and emoji text, style-only changes, single-cell edits and a
resize. It runs with observers on and off. Every frame it asserts that the displayed rows equal a
live read taken before acknowledgement, that the previous rows equal the prior frame's live read,
and that `rows` and `rowPatches` equal the old eager computation. Two mutations (ignoring the
revision, and sharing revisions without the text compare) each fail both cases.

## Measurements

MEASUREMENTS

## Decision

DECISION

## Production migration

Each step is one PR with its own failing-first test and a before/after on hardware. Each leaves
every observer's output unchanged and is reviewable on its own. Steps 1 and 2 are the prototype
split cleanly; the rest are new work.

1. **Revision-memoized displayed text.** Export per-row revisions from the retained frame; memoize
   text rows by `(row, revision)` across current and previous frames; delete the previous-text
   reader. No observer change yet. Test: equivalence over dense, scroll, Unicode and resize, plus a
   counter that a second read of an unchanged frame extracts zero rows.
2. **Observer text from the retained frame.** `FrameObserver.capture` takes text rows from the
   retained frame when it has one and no `onFrame` listener, instead of its y-indexed cache and a
   live read. Delete the dead branch for retained consumers. Test: the equivalence test with
   observers on, and the existing displayed-text, links, accessibility and held-output browser
   tests.
3. **Text revisions follow row identity.** Record the upstream row id and an inherited text
   revision in the retained frame; key the JS cache by text revision; enable matching after the
   first text read. Test: a scroll of N rows extracts N rows, and a same-id row whose text changed
   (or whose graphemes changed under equal raw cells) is re-read.
4. **Two native slots.** The previous frame keeps its revision list and pins its cached rows;
   `readPreviousTextRows` reads through them; the third slot goes. Test: `rowPatches` equivalence
   across 3+ frames without reads in between, and across a resize.
5. **Worker publication by revision** (with X4, whose binary delta format this keys). Publish the
   frame's revision list and rows for unknown revisions; the host keeps the same cache and
   rebuilds projection rows and the summary with the shared functions; drop the deep freeze of
   cloned rows. Test: the host's `visibleLines`, `onText`, links and accessibility outputs equal
   the main entry's over the same input, and a one-line scroll publishes one row.
6. **`rowPatches` from revisions.** Compare text only for rows whose revision changed. Output is
   identical by construction; the gain is skipping 50 string compares per frame.

Out of scope here and owned elsewhere: scratch records (X5, X6), the bridge row cache's O(R²)
matching (X6), and the upstream projection (ADR 001).

## Resources and cleanup

CLEANUP
