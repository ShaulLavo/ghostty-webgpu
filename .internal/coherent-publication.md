# Coherent live and displayed publication (X7)

Status: Approved research. Plan item X7 in `.internal/reference-study-2026-10/next-steps.md`.
Base: PR #9 head `b246eea93` (one shared render state per terminal). #9 has since moved to
`89933c289` (merge with main, native clean acknowledgement from #11, review fixes) and is not
merged. The research branch rebases onto main when #9 lands. Prototype: branch
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

Four commits on `research/coherent-publication`:

1. `b3872fc41`: the retained frame exports per-row revisions (`bridge_read_retained_revisions`).
   `DisplayedFrameStore` memoizes text rows by revision across current and previous frames. The
   frame observer takes its text rows from the retained frame when it has one and no `onFrame`
   listener. The previous-text reader is gone.
2. `e0c538a1b`: retained rows record the upstream row id and a text revision that follows identity
   while text is equal (`scripts/retained-frame.zig`, `textRevision`). The JS cache keys on the
   text revision alone. Identity matching costs one row compare per captured row, so it starts only
   after the first displayed-text read; until then each captured row gets a fresh revision.
3. `54fd89f8a`: fixes from the first hardware round. The cache keeps only revisions of the last
   two frames read. The first round's 4×rows bound raised the JS heap by up to 2.2 MB at 16
   terminals. Row ids are read only while matching is on, which removes a small observers-off cost.
   A failed text extraction after a native capture now discards the pending capture. Otherwise
   the next frame's capture would fail with "awaiting acceptance". I found this while
   retargeting the existing extraction-failure tests from the live reader to the retained reader;
   those tests now exercise it.
4. `800bf692b`: the cache keeps exactly the revisions of the readable slots (current, previous,
   pending). Commit 3's "last two reads" rule evicted the previous frame's rows just before the
   submitted summary read them. Dense redraws went back to 100 extracted rows per frame
   (counted at `54fd89f8a`: 99.8), which erased the dense gain on hardware. Now dense extracts 50.

The worker slice is not prototyped. Worker publication belongs to X4, which measured the
pooled design with binary row deltas and rejected it in #17, then approved a delta-only follow-up.
X7's contribution there is the patch key: publish by text revision, so a one-line scroll sends one
row, not fifty.

Equivalence: `src/core/tests/coherent-publication.test.ts` drives the real wasm through dense
redraws, scrolls with wide, combining and emoji text, style-only changes, single-cell edits and a
resize. It runs with observers on and off. Every frame it asserts that the displayed rows equal a
live read taken before acknowledgement, that the previous rows equal the prior frame's live read,
and that `rows` and `rowPatches` equal the old eager computation. Two mutations (ignoring the
revision, and sharing revisions without the text compare) each fail both cases.

## Measurements

### Protocol

`scripts/x7-publication-benchmark.ts` with `bench/x7-publication-entry.ts`. 200×50 at DPR 2, with 1 and 16 full
`Terminal` instances on one borrowed runtime. Two workloads: dense (every row rewritten each step)
and scroll (one new line each step). Each run is 180 measured steps after 30 warmup steps, one
animation frame per step.

- **Observers off:** no listeners and accessibility off. This is the default.
- **Observers on:** `onText`, `onFrame`, `visibleLines()` every step, and accessibility on.

Each cell is two counterbalanced before/after pairs (before then after, then after then before).
Every arm gets a fresh page. "Before" is PR #9 head `b246eea93`. "After" is `54fd89f8a` for the full
matrix, and `800bf692b` (the final prototype) for the 16-terminal observers-on confirmation cohort. Metrics:

- **CPU:** renderer and GPU process CPU from `SystemInfo.getProcessInfo`.
- **Main-thread time:** `ScriptDuration` and `TaskDuration` deltas per frame.
- **Memory:** JS heap after a forced GC, and wasm memory.
- **Output check:** a SHA-256 of every terminal's `visibleLines()` at the end. The script fails if
  a pair differs.

Tables show medians. Numbers are experimental: two pairs per cell, no significance claim. Raw
data is in `/work/reports/ghostty-webgpu-next-2026-10/x7/`.

### Representations and copies

| Path, 200×50                          | Before                                                                                    | After                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Text observers on, resident           | Native slots, observer y-cache, previous-text arrays, summary rows; five reader scratches | Native slots, one revision-keyed text cache shared by current and previous frames, summary rows; four reader scratches |
| Text rows extracted per frame, dense  | 100 (50 live + 50 previous)                                                               | 50                                                                                                                     |
| Text rows extracted per frame, scroll | 100                                                                                       | 1.05                                                                                                                   |
| Accessibility only, per refresh       | Current and previous frames in full                                                       | Rows with new text revisions only                                                                                      |
| Observers off                         | Unchanged: native capture of dirty rows, no text                                          | Unchanged; identity matching stays off until a text read                                                               |

Rows extracted come from counting bridge reads in the Node probe (`.internal/coherent-publication/probe.ts`).
Resident representations drop by one, the y-indexed observer cache, along with its per-frame
re-read. One reader scratch (12 B/cell, 120 KB per terminal) goes too, which is the 2 MiB wasm
drop at 16 terminals below.

### Node, real wasm, one terminal (attribution, not qualification)

Publication step (observer capture plus notify), median of three counterbalanced runs of 600
frames:

| Workload, observers | Before |                        After `e0c538a1b` |
| ------------------- | -----: | ---------------------------------------: |
| dense, off          |  35 µs |                                    34 µs |
| dense, on           | 222 µs |                                   148 µs |
| scroll, off         |  30 µs | 41 µs, then 32 µs with matching deferred |
| scroll, on          | 230 µs |                                    88 µs |

### PC, Linux, RTX 3060 Ti (WebGL2, WebGPU, DOM)

Full matrix at `54fd89f8a`, 2026-10-27, quiet heavy-runner admission, VRAM checked
above 2 GiB, ANGLE on the NVIDIA OpenGL ES driver for WebGL2/DOM and a non-fallback WebGPU adapter:

| backend | n   | workload | observers | rendererCpu before → after | gpuCpu before → after | scriptMs before → after | taskMs before → after | jsHeapUsed before → after | wasmBytes before → after | frames          | digests |
| ------- | --- | -------- | --------- | -------------------------- | --------------------- | ----------------------- | --------------------- | ------------------------- | ------------------------ | --------------- | ------- |
| dom     | 1   | dense    | off       | 32.36 → 32.19              | 7.67 → 7.17           | 1.46 → 1.44             | 3.93 → 3.90           | 3.23 → 3.24 MB            | 2.8 → 2.8 MiB            | 180/180/180/180 | equal   |
| dom     | 1   | dense    | on        | 34.36 → 36.22              | 7.84 → 8.51           | 1.50 → 1.61             | 4.13 → 4.41           | 3.33 → 3.34 MB            | 2.8 → 2.8 MiB            | 180/180/180/180 | equal   |
| dom     | 1   | scroll   | off       | 29.67 → 30.67              | 7.17 → 7.33           | 1.37 → 1.41             | 3.64 → 3.72           | 3.24 → 3.25 MB            | 2.8 → 2.8 MiB            | 180/180/180/180 | equal   |
| dom     | 1   | scroll   | on        | 30.83 → 32.00              | 6.83 → 7.67           | 1.39 → 1.44             | 3.76 → 3.88           | 3.34 → 3.35 MB            | 2.8 → 2.8 MiB            | 180/180/180/180 | equal   |
| dom     | 16  | dense    | off       | 131.42 → 128.67            | 12.91 → 10.73         | 19.76 → 19.73           | 49.76 → 49.50         | 9.66 → 9.66 MB            | 24.9 → 24.9 MiB          | 180/180/180/180 | equal   |
| dom     | 16  | dense    | on        | 128.58 → 130.24            | 9.91 → 10.96          | 21.14 → 20.31           | 55.80 → 54.53         | 10.29 → 10.07 MB          | 24.9 → 24.9 MiB          | 180/180/180/180 | equal   |
| dom     | 16  | scroll   | off       | 125.17 → 125.79            | 10.63 → 10.60         | 18.90 → 18.90           | 47.28 → 47.17         | 9.69 → 9.64 MB            | 24.8 → 24.8 MiB          | 180/180/180/180 | equal   |
| dom     | 16  | scroll   | on        | 124.21 → 123.98            | 9.50 → 9.69           | 19.28 → 19.11           | 50.83 → 50.08         | 10.14 → 9.99 MB           | 24.8 → 24.8 MiB          | 180/180/180/180 | equal   |
| webgl2  | 1   | dense    | off       | 7.50 → 6.84                | 4.17 → 4.67           | 0.80 → 0.75             | 1.01 → 0.96           | 2.93 → 2.94 MB            | 8.6 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgl2  | 1   | dense    | on        | 12.00 → 12.51              | 4.67 → 5.67           | 1.19 → 1.25             | 1.56 → 1.64           | 3.25 → 3.24 MB            | 8.7 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgl2  | 1   | scroll   | off       | 6.67 → 6.50                | 5.67 → 5.83           | 0.52 → 0.52             | 0.72 → 0.72           | 3.00 → 3.00 MB            | 8.6 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgl2  | 1   | scroll   | on        | 11.34 → 9.34               | 6.00 → 5.84           | 1.05 → 0.77             | 1.41 → 1.14           | 3.30 → 3.28 MB            | 8.7 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgl2  | 16  | dense    | off       | 77.84 → 78.29              | 26.17 → 28.26         | 11.47 → 11.52           | 12.55 → 12.63         | 4.22 → 4.23 MB            | 118.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgl2  | 16  | dense    | on        | 111.08 → 110.96            | 29.61 → 29.47         | 19.53 → 19.42           | 23.09 → 22.86         | 7.35 → 7.24 MB            | 120.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgl2  | 16  | scroll   | off       | 50.54 → 50.37              | 25.94 → 25.77         | 7.45 → 7.42             | 7.87 → 7.85           | 4.25 → 4.26 MB            | 118.1 → 118.1 MiB        | 180/180/180/180 | equal   |
| webgl2  | 16  | scroll   | on        | 108.32 → 76.04             | 25.78 → 26.67         | 13.45 → 9.05            | 15.76 → 11.46         | 7.87 → 6.86 MB            | 120.1 → 118.1 MiB        | 180/180/180/180 | equal   |
| webgpu  | 1   | dense    | off       | 7.56 → 8.67                | 6.12 → 7.00           | 0.89 → 0.97             | 1.08 → 1.21           | 2.89 → 2.89 MB            | 8.6 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgpu  | 1   | dense    | on        | 12.50 → 12.67              | 6.67 → 6.84           | 1.34 → 1.38             | 1.72 → 1.76           | 3.20 → 3.19 MB            | 8.7 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgpu  | 1   | scroll   | off       | 3.84 → 4.33                | 5.84 → 6.50           | 0.22 → 0.26             | 0.35 → 0.41           | 2.97 → 2.97 MB            | 8.6 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgpu  | 1   | scroll   | on        | 7.84 → 5.15                | 5.33 → 5.15           | 0.63 → 0.32             | 0.91 → 0.57           | 3.27 → 3.27 MB            | 8.7 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgpu  | 16  | dense    | off       | 82.14 → 81.33              | 73.16 → 75.07         | 12.33 → 12.49           | 13.35 → 13.52         | 4.20 → 4.21 MB            | 118.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | dense    | on        | 114.50 → 114.29            | 58.88 → 61.47         | 19.08 → 19.02           | 22.11 → 22.18         | 7.84 → 7.17 MB            | 120.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | scroll   | off       | 18.54 → 18.50              | 37.26 → 37.17         | 2.14 → 2.07             | 2.51 → 2.44           | 4.28 → 4.29 MB            | 118.1 → 118.1 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | scroll   | on        | 77.76 → 43.89              | 37.15 → 37.41         | 8.11 → 3.64             | 10.62 → 5.96          | 8.31 → 6.94 MB            | 120.1 → 118.1 MiB        | 180/180/180/180 | equal   |

Confirmation at the final `800bf692b`, 16 terminals, observers on:

| backend | n   | workload | observers | rendererCpu before → after | gpuCpu before → after | scriptMs before → after | taskMs before → after | jsHeapUsed before → after | wasmBytes before → after | frames          | digests |
| ------- | --- | -------- | --------- | -------------------------- | --------------------- | ----------------------- | --------------------- | ------------------------- | ------------------------ | --------------- | ------- |
| dom     | 16  | dense    | on        | 130.05 → 132.21            | 10.71 → 10.35         | 20.26 → 20.52           | 54.51 → 54.81         | 10.25 → 9.92 MB           | 24.9 → 24.9 MiB          | 180/180/180/180 | equal   |
| dom     | 16  | scroll   | on        | 124.46 → 124.76            | 9.79 → 9.46           | 19.40 → 19.25           | 51.26 → 50.72         | 9.99 → 10.12 MB           | 24.8 → 24.8 MiB          | 180/180/180/180 | equal   |
| webgl2  | 16  | dense    | on        | 111.10 → 107.83            | 23.75 → 28.06         | 17.83 → 15.59           | 21.06 → 18.66         | 7.58 → 7.09 MB            | 120.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgl2  | 16  | scroll   | on        | 105.66 → 74.72             | 24.99 → 26.63         | 13.13 → 8.84            | 15.43 → 11.14         | 7.62 → 6.55 MB            | 120.1 → 118.1 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | dense    | on        | 114.81 → 108.99            | 57.54 → 68.11         | 18.78 → 15.59           | 21.74 → 18.35         | 8.17 → 6.89 MB            | 120.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | scroll   | on        | 75.40 → 39.70              | 34.97 → 32.86         | 7.82 → 3.29             | 10.14 → 5.47          | 8.26 → 6.95 MB            | 120.1 → 118.1 MiB        | 180/180/180/180 | equal   |

### Mac, M1, WebGPU (Metal), AC power

Full matrix at `54fd89f8a`, load average 1.9 at start:

| backend | n   | workload | observers | rendererCpu before → after | gpuCpu before → after | scriptMs before → after | taskMs before → after | jsHeapUsed before → after | wasmBytes before → after | frames          | digests |
| ------- | --- | -------- | --------- | -------------------------- | --------------------- | ----------------------- | --------------------- | ------------------------- | ------------------------ | --------------- | ------- |
| webgpu  | 1   | dense    | off       | 26.60 → 25.90              | 12.41 → 11.99         | 3.38 → 3.32             | 3.82 → 3.72           | 2.89 → 2.90 MB            | 8.6 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgpu  | 1   | dense    | on        | 36.94 → 37.64              | 11.33 → 11.43         | 4.24 → 4.25             | 5.16 → 5.17           | 3.34 → 3.24 MB            | 8.7 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgpu  | 1   | scroll   | off       | 15.57 → 15.87              | 17.80 → 17.78         | 0.97 → 0.99             | 1.48 → 1.53           | 2.97 → 2.98 MB            | 8.6 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgpu  | 1   | scroll   | on        | 22.92 → 21.71              | 12.31 → 15.90         | 1.81 → 1.44             | 2.69 → 2.52           | 3.41 → 3.33 MB            | 8.7 → 8.6 MiB            | 180/180/180/180 | equal   |
| webgpu  | 16  | dense    | off       | 103.85 → 103.71            | 30.03 → 36.64         | 17.52 → 17.62           | 18.79 → 18.83         | 4.23 → 4.24 MB            | 118.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | dense    | on        | 118.18 → 116.51            | 17.87 → 16.89         | 25.87 → 25.54           | 30.69 → 30.46         | 7.48 → 7.27 MB            | 120.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | scroll   | off       | 31.72 → 31.32              | 29.37 → 29.51         | 3.69 → 3.61             | 4.27 → 4.17           | 4.31 → 4.31 MB            | 118.1 → 118.1 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | scroll   | on        | 103.45 → 63.19             | 24.57 → 25.11         | 9.97 → 4.70             | 13.31 → 8.11          | 8.29 → 6.82 MB            | 120.1 → 118.1 MiB        | 180/180/180/180 | equal   |

Confirmation at the final `800bf692b`, 16 terminals, observers on, load average 4.9 at start:

| backend | n   | workload | observers | rendererCpu before → after | gpuCpu before → after | scriptMs before → after | taskMs before → after | jsHeapUsed before → after | wasmBytes before → after | frames          | digests |
| ------- | --- | -------- | --------- | -------------------------- | --------------------- | ----------------------- | --------------------- | ------------------------- | ------------------------ | --------------- | ------- |
| webgpu  | 16  | dense    | on        | 119.43 → 111.27            | 19.75 → 20.97         | 25.85 → 21.89           | 30.60 → 26.60         | 7.58 → 7.35 MB            | 120.2 → 118.2 MiB        | 180/180/180/180 | equal   |
| webgpu  | 16  | scroll   | on        | 103.39 → 62.99             | 24.84 → 25.83         | 9.96 → 4.81             | 13.32 → 8.23          | 8.28 → 6.90 MB            | 120.1 → 118.1 MiB        | 180/180/180/180 | equal   |

### Reading the tables

- **CPU percentages are per wall-clock second.** When the main thread was overloaded, 180 frames
  took longer. In 16-terminal dense with observers on, the before arm took 3.9–4.1 s and the after
  arm 3.3 s. The GPU process did the same work per frame (12.5 against 12.3–12.7 ms of CPU per
  frame on PC WebGPU), so its percentage rises. Script and task times are per frame and are the
  primary measure.
- **The DOM backend shows no gain.** DOM layout and paint dominate its frame (about 50 ms of task
  time per frame at 16 terminals), so text publication is noise there. It shows no regression
  either.
- **Single-terminal observers-off cells on PC WebGPU** read 0.04–0.08 ms higher per frame in both
  rounds. The same path at 16 terminals is equal or lower (2.14 → 2.07 ms), which a per-terminal
  cost would multiply rather than hide. The Mac shows no difference. I treat it as noise and name
  it for the step 1 PR to re-measure.

An earlier round on both hosts (after = `e0c538a1b`, 4×rows cache bound) showed the same CPU
pattern, but the JS heap rose by up to 2.2 MB at 16 terminals with observers on. That run is kept
as `pc-hardware-r1.json` and `mac-r1/`. Commit `54fd89f8a` fixed the heap, which the full matrices
show. The confirmation cohorts show `800bf692b` restoring the dense gain that `54fd89f8a` lost.

## Decision

**KEEP.** The gate was fewer representations at equal or lower CPU and memory, with every
observer's output unchanged. It passes on both hosts:

- **Fewer representations.** The observer's y-indexed text cache, the per-frame previous-text
  re-extraction and one reader scratch are gone. Current and previous frames share one
  revision-keyed text cache derived from the retained native frame.
- **Output unchanged.** Every hardware pair has equal text hashes and equal frame counts. The Node
  equivalence test checks `rows`, `rowPatches`, previous rows and per-cell text against the old
  computation every frame. The existing displayed-text, links, accessibility, synchronized-output,
  held-output and multiple-render-state browser tests pass unchanged; the two extraction-failure
  tests now inject at the retained reader.
- **CPU.** With observers on at 16 terminals, script time per frame falls on scroll (WebGPU −58%
  PC, −52% Mac; WebGL2 −33%) and on dense (WebGPU −17% PC, −15% Mac; WebGL2 −13%). Other cells are
  equal within the noise named above.
- **Memory.** The JS heap ranges from +0.13 MB (DOM scroll, within run-to-run spread) to −1.4 MB
  across the final cells. It falls 1.0 to 1.4 MB on GPU backends at 16 terminals with observers
  on. Wasm memory is 2 MiB lower at 16 terminals.

Not decided here: the worker step (5) needs X4's delta-only run, and the two-slot step (4) needs
its own measurement. The prototype is research code. It is not merged; production follows the
steps below.

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
5. **Worker publication by revision.** This is the key for X4's approved "Delta-only follow-up"
   (`.internal/worker-pool-experiment.md` on main, after #17 rejected the pooled WebGL2 bundle).
   Publish the frame's ordered text-revision list and rows only for revisions the host lacks. The
   host keeps the same revision cache and rebuilds projection rows and the summary with the shared
   functions, so the deep freeze of cloned rows goes. Rows carry text, cell boundaries and
   continuation flags, the parts X4's text-only sketch left out. Test: host `visibleLines`,
   `onText`, links and accessibility equal the main entry's over the same input, and a one-line
   scroll publishes one row.
6. **`rowPatches` from revisions.** Compare text only for rows whose revision changed. Output is
   identical by construction; the gain is skipping 50 string compares per frame.

Out of scope here and owned elsewhere: scratch records (X5, X6), the bridge row cache's O(R²)
matching (X6), and the upstream projection (ADR 001).

## Resources and cleanup

Raw data, logs and run scripts are in `/work/reports/ghostty-webgpu-next-2026-10/x7/`:

- PC rounds: `pc-hardware-r1.json`, `-r2.json` and `-r3.json`, with their logs.
- Mac rounds: `mac-r1/`, `mac/` and `mac-r3/`.
- Node probes: `node-probe*.jsonl`.
- Gate and test logs.

Instruments are on the research branch: `.internal/coherent-publication/{probe,ops}.ts`,
`summarize.py`, `bench/x7-publication-entry.ts` and `scripts/x7-publication-benchmark.ts`. To
reproduce the PC matrix from the research worktree, with a "before" worktree at `b246eea93`, run
`X7_BEFORE_ROOT=<before> bun scripts/x7-publication-benchmark.ts` through the heavy runner's quiet
bench class.

Removed after the runs: the Mac scratch (`~/tmp/ghw-x7`, its clone and two worktrees, staged twice), the PC
baseline worktree, the pinned Ghostty worktree in `/work/tmp`, the identity scratch worktree and
the size probe. Each harness run closed its browser in `finally`. The harness serves pages through
request interception, so it creates no server.
