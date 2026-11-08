# Run a selected browser file on iOS

This source-only route uses the published Waffle 0.0.111 framework host and the normal Vitest lifecycle. It does not run the whole browser suite.

## Prerequisites

Use an exclusive checkout, Bun 1.4.4, and Node 26.12.1 on macOS. Install dependencies with `bun install --frozen-lockfile`. The lockfile pins the public Waffle runtime tarball and its integrity. Waffle, WebdriverIO, and Undici are development dependencies, not terminal runtime dependencies.

The parent execution owner must supply an already selected iOS Simulator UUID and own the Safari turn. Follow the fleet and device procedures before running this command. The runner does not reserve or boot a simulator. Do not run concurrent native stages.

## Select one complete file

Run the synthetic stage first. Supply a new absolute result path in an existing writable directory.

```sh
bun run test:browser --native-ios --stage synthetic --udid "$SIMULATOR_UUID" --result "$RESULT_DIRECTORY/synthetic.json"
```

The other supported stages are `viewport`, the complete five-case saved-viewport file, `bulk-snapshot`, the complete one-case bulk-snapshot file, and `font-resources`, the complete five-case font-resource file. The font stage expands both original retirement parameters and uses the checked-in replacement WOFF2 plus the original invalid data URL. It needs no additional provider operation. Each stage has an independent manifest. Source hashes reject changed registrations before allocation. There is no arbitrary file or name filter on this route.

The equivalent explicit source command is:

```sh
node scripts/ios-browser-launch.ts --stage viewport --udid "$SIMULATOR_UUID" --result "$RESULT_DIRECTORY/viewport.json"
```

A sound selected-file run exits **4**, including when every selected case passes. Capture that status explicitly in shell automation. Infrastructure or cleanup failure exits 2. Invalid preconditions exit 3. The result preserves ordinary test failure independently, and `rootBrowserSuiteComplete` always remains false. No current root denominator is inferred from historical inventories.

The read-only verifier checks a recorded result and its separate launcher receipt:

```sh
node scripts/ios-browser-verify.ts viewport "$RESULT_DIRECTORY/viewport.json"
```

Verifier exit 0 means that the recorded partial-file check passed. It does not change the run's exit 4 or establish whole-root acceptance.

## Keep ownership and scope explicit

The host mounts before session creation. The parent alone creates and deletes the session. The provider detaches on close and rejects reopening. The owned Undici dispatcher stays installed until actual framework, server, provider, session, and callback joining finishes. The outer Node process has a finite joining bound. Retain results and any unconfirmed cleanup resources for the parent rather than retrying automatically.

Native stages preserve 15-second cases, 30-second hooks, zero retries, original geometry, and all original test bodies and assertions. Only the automatic logical viewport measurement receives a permit. Explicit viewport changes, trusted input, screenshots, and CDP commands remain unsupported.

Ordinary `bun run test:browser` still uses Playwright, the existing browser selection, and `insertText`. The native module loads only in instrumented documents.

## Interpret the tests

The discovered `scripts/ios-browser*.test.ts` tests include public installed-package contracts, no-browser SDK plus Vite and WebSocket controls, real Chromium with a labelled observation double, ordinary desktop input, process joining, and read-only result guards. The observation double proves Ghostty lifecycle ordering and RPC behavior. It does not prove Waffle document binding or native retirement.

Historical native synthetic, viewport, and bulk-snapshot results used unpublished archive 06. They are not native runs of release 0.0.111. Their unknown SDK session-context warning remains unresolved evidence, not a claim of zero unsupported Safari HTTP. This supported dependency adoption does not add native or whole-root qualification, exclusions, skips, or relaxed clocks.

The font-resource stage is source-prepared only. Ordinary Chromium execution does not establish native font-event behavior or release 0.0.111 qualification. The parent must supply a fresh Safari turn and keep the selected-file exit 4 and whole-root false distinction.

The `measurement` stage selects the unchanged four-case public width and geometry file. It preserves the title and data parameter rows, the terminal and host cleanup hook, and the original 320 by 120 CSS host. It uses the checked-in `ghostty-vt.wasm` and `bridge.wasm` with normal platform font fitting. No screenshot, trusted input, explicit viewport operation, or new host API is needed. This stage is source-prepared only. Desktop success is not Safari qualification.

The asynchronous ownership batch adds three independent stages. `write-queue` runs the
complete five-case file, `presentation` runs all three cases including the original
`undefined` and `canvas2d-fill-text` parameters, and `scrollbar-async` runs its complete
one-case file. Run these stages sequentially in one separately parent-owned Safari turn,
with a new result and launcher receipt for each stage. The scrollbar file dispatches its
original synthetic `WheelEvent`; it does not request trusted provider input.

These stages preserve all cleanup hooks, animation-frame waits, the five-second write
settling deadline and ten-millisecond polling, normal fonts, and the checked-in Wasm
assets. The presentation file retains its automatic backend choice. No new host API,
controller, viewport command, screenshot, fixture input, or clock override is introduced.
All three are source-prepared only. Host exit 4 and verifier exit 0 remain selected-file
evidence, never whole-root completion or native qualification from desktop results.

The text API batch adds `history` and `readline-layout` as independent stages. Run them
sequentially with separate results and launcher receipts. The complete history file
has five cases, including both main and worker parameter rows. It retains its original
Chromium suite title, 20,000-line input, row-cap loop, normal automatic backend choice,
and actual JetBrains Mono worker font. The complete multiline file has two cases using
the built line-editor addon, original paste and key API calls, Canvas renderer, six-row
grids, zero-millisecond settling wait, and soft cursor assertion. These are terminal
API calls, not trusted provider input. Both files retain their original cleanup hooks.

Only source preparation and ordinary desktop evidence belong to this batch. No native
run or startup-cause fix is claimed. Keep earlier source-specific passed records separate.
Waffle, provider operations, clocks, exclusions, and whole-root false semantics do not change.

The `module-mock` stage selects the complete one-case module-mocking original. Its
factory, mocked import, `vi.importActual` call, and both exact string assertions remain
unchanged. Vitest resolves the package through its existing Vite mock registry and
WebSocket RPC. No trusted provider command, font, Wasm asset, helper, hook, explicit
viewport change, or database operation is required. The locked package is
`@discoveryjs/json-ext` 1.1.0. This stage is source-prepared only. Run it only in a
separately parent-owned Safari turn after review and ready-head CI. Selected-file host
exit 4, verifier exit 0, and whole-root false semantics remain unchanged.

The `font-geometry` stage selects the complete three-case original. It retains the
loaded JetBrains Mono font, both font hooks, all four cleanup callbacks, the nested
pixel-ratio and line-height loops, mounted Canvas pixel checks, and the locked
`ghostty-web` Canvas renderer. It needs only normal browser APIs and existing public
host operations. No provider screenshot, input, viewport command, or new host API is
added. This stage is source-prepared only. Desktop correctness is not Safari
qualification. Keep host exit 4, verifier exit 0, and root completion false.

The `canvas-rasterizer` stage selects all eight unchanged glyph-rasterization cases.
It keeps the 4,096-glyph retention loop, data-dependent four-MiB pixel loop, five DPR
values, numeric font weights, cache identity and bitmap assertions. The original uses
system monospace and normal CJK and color-emoji fallback through Canvas 2D. No font
fixture, screenshot oracle, trusted input or host operation is substituted. This stage
is prepared only. Browser font behavior still needs a parent-owned Safari run after
review, ready-head CI, merge and main CI. Host exit 4 and root completion false remain.

The `stamp-cache` stage selects all six unchanged resident stamp cache cases. It
uses the original reference cache and storage fixture, Canvas raster bytes, ordinary
WebAssembly memory growth, and Vitest mocks. The storage fixture's production-cache
import is type-only. No Wasm binary, font file, image, worker or addon is fetched by
this graph. System monospace, emoji fallback and browser identity remain unchanged.
The failed-operation case retains its original clean cache retry, not a test retry.
This stage is prepared only. The parent owns review, CI, merge, main CI and the next
Safari turn. Host exit 4, verifier exit 0 and root completion false remain unchanged.

The `pixel-damage` stage selects the complete five-case pixel-damage original.
It retains DPR 1, 1.25, 1.5 and 2, exact displayed and uploaded RGBA comparisons,
all fourteen transition rows, the injected transport failure and inherited-filter
scroll case. Every renderer uses the unchanged manual TestClock maps and flushFrame.
The shared fixture defines a screenshot helper, but this original never calls it.
Real runtime, bridge and compositor Wasm load through their normal asset URLs.
No provider operation, fixture replacement or clock override is added. This stage
is prepared only. The parent owns native scheduling and completion assessment.
Batch 06's eight passing native bodies did not complete adapter retirement and do
not establish file completion. No failed original is replayed by this preparation.

The `mounted-scroll` stage selects the complete two-case mounted public Terminal
scroll original. Both `canvas2d-fill-text` and `canvas2d-pixels` retain the original
manual TestClock scheduling, real animation-frame waits, 32-column by six-row grid,
scroll notifications, row-read packing and reuse metrics. After initial output and
every scroll, displayed RGBA equals a separately created full-reference renderer.
The shared fixture's screenshot helper is not called. The full public Terminal
import graph, system monospace and emoji fallback, Wasm assets and cleanup remain
unchanged. This is preparation only. The parent owns review, CI, merge and native
intake. No earlier complete, failed or prepared original becomes eligible to replay.

The `dom-appearance` stage selects the complete single-case DOM appearance
retention original. It loads the real JetBrains Mono test font and uses the public
session terminal factory with its actual DOM renderer. Cursor-only repaint counts,
frame and appearance events, current CSS offsets, palette changes, retained
snapshots after Wasm memory growth and a reentrant theme update stay unchanged.
All original callbacks, assertions, animation-frame waits and reverse-order cleanup
remain intact. This is preparation only, not a Safari or native completion claim.

The `ghostty-keymap` stage selects the complete 13-case terminal keymap original.
It retains both legacy and kitty rows, all three scroll-platform rows, the platform
getter spy, synthetic KeyboardEvents, composition and modifier checks, queued writes,
and original cleanup. These are ordinary DOM events, not trusted provider input.
The locked `@fregat/hotkeys` package and its TanStack Store dependency are required.
Native and bridge Wasm load normally. The original uses system monospace and Canvas
fill-text, with no test font, worker or compositor asset request. This stage is
prepared only. Host exit 4, verifier exit 0, and whole-root false semantics stay fixed.

Batch 14 adds `mac-keybindings` for the complete unchanged
`src/dom/tests/mac-keybindings.browser.test.ts`. It retains eight cases, including
both main/worker terminal and legacy/kitty protocol rows. Build root dist before
running it. The worker loads the built entry, the JetBrains Mono fixture and both
root Wasm assets. The original uses real clocks and synthetic DOM key events, not
provider keyboard commands. This preparation adds no native completion credit.

The `output-timing` stage selects the complete unchanged
`src/dom/tests/output-timing.browser.test.ts`. It includes all four renderer and
presentation combinations, the burst and listener lifecycle cases, and the built
worker case. The original real waits, quiet periods and output timing payload
assertions are preserved. Its source preparation does not establish Safari or
root-suite completion.

The `ui-declarations` stage selects the complete unchanged
`src/dom/tests/ui-declarations.browser.test.ts`. All 13 cases remain, including
worker-only and host-loaded fonts, synchronous composition input, inert-document
preedit, peer callback ordering, style priorities, observers and caret validation.
Build root dist before the worker rows. They load the real font and both root Wasm
assets. Synthetic DOM composition and input events do not require provider input
commands. Original waits, animation frames and reverse cleanup remain unchanged.
This is source preparation, not Safari or whole-root completion.

The `managed-fallback` stage selects the complete six-case
`src/render/tests/fallback.browser.test.ts`. It retains native frame-builder
attachment, real WebGL context loss, all backend fallback paths, Canvas2D pixel
checks, focus and visibility changes, disposal and abort, error callbacks and
reduced-motion updates. The original TestClock maps and flushes, default polls,
mocks and cleanup are unchanged. Its imported fixture defines a screenshot helper
that none of these cases calls. No worker or font file is requested. System
monospace, native and bridge Wasm remain real. This is source preparation, not
Safari or whole-root completion.

The `worker-write-queue` stage selects complete
`src/worker/write-queue.browser.test.ts`. Its four cases keep the real `dist` worker,
worker-loaded test font, WebGL canvas, MessagePort transfer spy, ordered controls,
cancelled neighbor and eight disposal rejections. Queue and worker clocks stay
unchanged. Root `dist` is a prerequisite. This differs from the main-thread
`write-queue` stage and does not establish Safari or whole-root completion.

The `glyph-fidelity` stage selects complete
`src/render/tests/glyph-fidelity.browser.test.ts`. Its four cases keep actual Canvas
coverage, combining text and wide spans, native continuation ownership and transparent
cells, and the five fractional DPR grid inputs. Canvas raster pixels are not provider
screenshots. No worker or downloadable font is used. Both native Wasm assets load
through the ordinary source runtime. Original bytes, callbacks and default 15,000 ms
case clocks stay unchanged. Batch 32 preparation and saved desktop evidence are
documented in `.internal/ios-browser-batch32.md`. Native intake remains parent-owned.

The `selection-worker-ownership` stage selects complete
`src/dom/tests/selection-worker-ownership.browser.test.ts`. All three rows retain
real packaged worker ownership while cancel, dispose or a new press interrupts a
stale release. The original uses WebGL, its actual font and native/bridge Wasm,
selection snapshots, ordered request fences and real resize authority. Its direct
controller calls need no trusted provider click. Explicit 15,000 ms cases, the
5,000 ms projection bound and 10 ms waits stay unchanged. Waffle remains published
0.0.111. This stage adds no provider capability or exclusion.

## Canvas-image publications

The `canvas-image` stage selects complete
`src/dom/tests/canvas-image.browser.test.ts`. All 38 cases keep the original
WebGL, direct and coordinated WebGPU, Canvas, pixels and DOM rows. It checks
canvas-image delivery, direct pixel copies, submit failure and recovery, observer
order, transparent erasure, disposal, blink, foreign-realm rejected promises,
previous-frame reads and reentrant writes. Original clocks and cleanup remain
unchanged. These image reads are not provider screenshots.

```sh
node scripts/ios-browser-launch.ts --stage canvas-image --udid "$SIMULATOR_UUID" --result "$NEW_ABSOLUTE_RESULT_JSON"
node scripts/ios-browser-verify.ts canvas-image "$NEW_ABSOLUTE_RESULT_JSON"
```

Native execution belongs to the parent after review, CI, merge and fresh intake.
Whole-root completion remains false.

The `displayed-frame-boundaries` stage selects complete
`src/dom/tests/displayed-frame-boundaries.browser.test.ts`. All 18 current cases
retain real native state, WebGL and direct or coordinated WebGPU, original
DeferredClock callbacks and failure injection, owned snapshots, reentrant text,
accessibility polling and shared-coordinator image publication order. Canvas and
DOM fixture options remain uncalled. Source-image subscription is not a provider
screenshot. This preparation adds no native or whole-root completion credit.

```bash
node scripts/ios-browser-launch.ts --stage displayed-frame-boundaries --udid "$SIMULATOR_UUID" --result "$NEW_ABSOLUTE_RESULT_JSON"
node scripts/ios-browser-verify.ts displayed-frame-boundaries "$NEW_ABSOLUTE_RESULT_JSON"
```

## GPU texture arrays

The `gpu-textures` stage selects all three cases in
`src/render/webgpu/gpu-textures.browser.test.ts` unchanged. It requests a real
high-performance WebGPU adapter and device, uploads odd-stride dirty rectangles,
and checks bytes read from GPU texture arrays through mapped buffers. It also
checks the adapter layer limit and preservation when only grayscale grows.
No font, worker, Ghostty Wasm, page viewport or provider screenshot is required
by this original. A normal GPU readback is the original oracle, not a screenshot
substitute. Preparation adds no native pass credit.
