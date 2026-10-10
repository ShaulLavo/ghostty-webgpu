# ghostty-webgpu

## 0.3.24

### Patch Changes

- [#1256](https://github.com/ShaulLavo/fregat/pull/1256) [`402e9f3`](https://github.com/ShaulLavo/fregat/commit/402e9f3ad2b7aa478e0b7003649422c0f5299748) - Improved `Terminal` output performance while its default scrollbar is hidden. Accessibility values stay current, and the thumb uses its latest size and position before appearing or handling input.

## 0.3.23

### Patch Changes

- [#1248](https://github.com/ShaulLavo/fregat/pull/1248) [`7b40f8d`](https://github.com/ShaulLavo/fregat/commit/7b40f8daf886d02bb810393ebf34afc97bf2ca96) - Improved the default Canvas text renderer's CPU use during complete repaints while preserving exact glyph pixels.

## 0.3.22

### Patch Changes

- [#1206](https://github.com/ShaulLavo/fregat/pull/1206) [`89607da`](https://github.com/ShaulLavo/fregat/commit/89607da8dbf8bfe65a9ad453c812a8d780b5f4af) - Fixed initial automatic renderer selection to choose WebGL for software WebGPU adapters, including worker terminals. WebGPU terminals can repaint with a software replacement after device loss. Replacement acquisition failures reach the renderer's `onError` callback and the terminal's `error` event.

- [#1162](https://github.com/ShaulLavo/fregat/pull/1162) [`e5c8de7`](https://github.com/ShaulLavo/fregat/commit/e5c8de780a66ffb12fa941f7ff9d77d0ff1ad908) - Improved WebGL rendering efficiency for sparse terminal content. `metrics.draws` now counts the draw calls actually submitted for each frame.

- [#1229](https://github.com/ShaulLavo/fregat/pull/1229) [`917e6da`](https://github.com/ShaulLavo/fregat/commit/917e6da49cd610209ecb7d55508ed8275f76e5e6) - Improved `canvas2d-fill-text` rendering speed for rapidly scrolling terminal output.

- [#1208](https://github.com/ShaulLavo/fregat/pull/1208) [`7d6f95d`](https://github.com/ShaulLavo/fregat/commit/7d6f95d3d3ac9d924104f739c7340cfa50ed8e3e) - Changed `backend: 'auto'` and the main-thread automatic renderer to prefer WebGL on desktop Linux, where it measured lower CPU work than WebGPU. macOS and Windows still prefer hardware WebGPU, and explicit `backend: 'webgpu'` keeps its current behavior. Automatic selection continues after WebGL resource allocation failures, and managed WebGL context-loss recovery tries the remaining backends in platform order.

- [#1210](https://github.com/ShaulLavo/fregat/pull/1210) [`f6eef9d`](https://github.com/ShaulLavo/fregat/commit/f6eef9d590c8377bdb8b4442e1a79fc4668e102a) - Improved DOM rendering with contained fixed-row layout, direct plain-row text projection, and reused styles while preserving every terminal column, immutable snapshot, styled cell, selection, cursor, and wide glyph. Reused live canvas style declarations while keeping per-frame flow and padding updates. Fixed DOM `setTheme` colours when a host mutates and reapplies an RGB object.

- [#1146](https://github.com/ShaulLavo/fregat/pull/1146) [`25f35de`](https://github.com/ShaulLavo/fregat/commit/25f35de8fdd0130a51408ef409b3ae5905b8d576) - Breaking: `submittedFrame` now contains frame metadata only; read displayed text with synchronous `visibleLines()` or subscribe with `onText(({ frame, rows, rowPatches }) => …)`, disposing the returned subscription when finished. Displayed text and public renderer `onTextFrame` snapshots remain readable after later frames or disposal; `onText` delivers accepted frames in order after opening, and failures before frame acceptance preserve prior metadata, lazy text and styled snapshots. WebGL and WebGPU create owned text on demand, and accessibility is opt-in through `accessibility: {}` or `setAccessibilityEnabled(true)` with its text subscription released when disabled.

- [#1141](https://github.com/ShaulLavo/fregat/pull/1141) [`97fa72f`](https://github.com/ShaulLavo/fregat/commit/97fa72ffc9388e4273d94ec4d2e754a0e7d78575) - Breaking: Move custom drawing and overlays off `terminal.canvas` onto a separate canvas.
  Improved `canvas2d-pixels` scrolling and small edits to upload fewer pixels while preserving exact output and failed-upload recovery.
  Changed: The renderer owns `terminal.canvas` and its drawing context, and pixel mode assumes no active clip.

- [#1128](https://github.com/ShaulLavo/fregat/pull/1128) [`5636f74`](https://github.com/ShaulLavo/fregat/commit/5636f7469198f43424bd0bdc30bf8db6c09ceb61) - Fixed comparison packets to include and hash every runtime WASM asset, including the Canvas pixel compositor. Packets built with `--runtime-ref` now keep these assets tied to the selected source revision.

- [#1180](https://github.com/ShaulLavo/fregat/pull/1180) [`fb67ac0`](https://github.com/ShaulLavo/fregat/commit/fb67ac08ded224fd6579389a23796e015ee23d5c) - Improved DOM rendering of sparse rows. `renderFrameToHtml` omits default empty cell text while preserving fixed-grid run widths, wide-glyph spacing, cursor paint, selection, and styled cells.

- [#1244](https://github.com/ShaulLavo/fregat/pull/1244) [`8b2d69b`](https://github.com/ShaulLavo/fregat/commit/8b2d69bfb4e4640a99ab2c52f8f28c4cfd9f5468) - Fixed terminal taps dismissing the on-screen keyboard in iPhone Safari. The terminal input keeps focus so touch users can type and receive echoed output.

- [#1136](https://github.com/ShaulLavo/fregat/pull/1136) [`0675313`](https://github.com/ShaulLavo/fregat/commit/067531315906e6c5b6ecc73136fa4736281b84b6) - Improved WebGPU terminal scrolling by retaining unchanged rows in GPU buffers and uploading changed record ranges. WebGPU devices with multiple glyph storage batches retain their existing rendering layout.

## 0.3.21

### Patch Changes

- [#972](https://github.com/ShaulLavo/fregat/pull/972) [`74d4c92`](https://github.com/ShaulLavo/fregat/commit/74d4c92073d7b28961eb1f663e5f926ddf621e78) - Improved CPU efficiency during DOM terminal updates while keeping input and text positioning aligned with page layout and restoring terminal styles after host changes.

- [#1066](https://github.com/ShaulLavo/fregat/pull/1066) [`5d50acd`](https://github.com/ShaulLavo/fregat/commit/5d50acdbaaad9b3a9a23080632c2cf2dea2c538d) - Improved Canvas rendering efficiency when editing plain text while preserving glyph and cursor appearance.

- [#1073](https://github.com/ShaulLavo/fregat/pull/1073) [`5b0f541`](https://github.com/ShaulLavo/fregat/commit/5b0f541b666ab21e440c846f0d6af7fcead618df) - Fixed Canvas repainting after a drawing failure so retried updates refresh every affected row and preserve transparent backgrounds.

- [#1055](https://github.com/ShaulLavo/fregat/pull/1055) [`71a187b`](https://github.com/ShaulLavo/fregat/commit/71a187b52d2acd0ea53cf18bd4accb1b533de1a8) - Improved scrolling CPU efficiency in experimental Canvas pixel mode.

- [#1030](https://github.com/ShaulLavo/fregat/pull/1030) [`6baf9d0`](https://github.com/ShaulLavo/fregat/commit/6baf9d0fe0008e91190e0d61870984017cb26571) - Improved Canvas repainting for single-row plain-text edits and cursor changes. Font loading refreshes glyph bounds, and bulk writes, styled rows and pixel targets keep full-row painting.

- [#887](https://github.com/ShaulLavo/fregat/pull/887) [`6b1a415`](https://github.com/ShaulLavo/fregat/commit/6b1a4157c7818f24f9518829378c07259f2385de) - Fixed terminal comparison benchmarks failing to start Chromium when the output directory has a long path.

- [#888](https://github.com/ShaulLavo/fregat/pull/888) [`f0b3dff`](https://github.com/ShaulLavo/fregat/commit/f0b3dff6e5832b9589312d7e5618056aabf0cfa4) - Fixed terminal comparison benchmarks failing to read or write large JSON results. An interrupted or failed write preserves the last complete checkpoint.

- [#970](https://github.com/ShaulLavo/fregat/pull/970) [`d19fc4e`](https://github.com/ShaulLavo/fregat/commit/d19fc4e4904cd9888c32f3dc4c7b419ea6e7c1fb) - Terminal comparisons on macOS no longer discard a measurement when a process's fast-core time comes out a few nanoseconds above its total CPU time because of unit-conversion rounding.

- [#929](https://github.com/ShaulLavo/fregat/pull/929) [`d494dd4`](https://github.com/ShaulLavo/fregat/commit/d494dd45fb43eb0ecbd1f001af7c906a0fda4b58) - Added optional instruction counts, CPU cycles, core placement, effective-clock ratios, and CPU energy estimates to terminal comparison reports on supported systems. Existing CPU measurements and pass criteria stay unchanged.

- [#889](https://github.com/ShaulLavo/fregat/pull/889) [`51c639c`](https://github.com/ShaulLavo/fregat/commit/51c639c5f819856692fdce3f303942e6e82985b3) - Fixed browser tests registering an unused WebSocket server hook when standalone mock interception is disabled.

- [#880](https://github.com/ShaulLavo/fregat/pull/880) [`126492a`](https://github.com/ShaulLavo/fregat/commit/126492af5551a4d0c7ef1701ac38baa8a0693f11) - Added a guide for running resumable terminal performance investigations with `bun run autoresearch:checkpoint`. Saved checkpoints let a later run continue the investigation.

- [#977](https://github.com/ShaulLavo/fregat/pull/977) [`09d3cb0`](https://github.com/ShaulLavo/fregat/commit/09d3cb0a85c5a2ebd809bb3b5d2269fe7fcf59f5) - Reuse unchanged terminal rows during scrolling in the WebGL and WebGPU frame builders. Preserve exact glyph placement, colors, selection, cursor, history, and upload ranges while rebuilding incoming or changed rows.

- [#931](https://github.com/ShaulLavo/fregat/pull/931) [`c5a6fb2`](https://github.com/ShaulLavo/fregat/commit/c5a6fb2232cfe2732d0c3fe6c71cdf56ba8ccdf6) - Added `scrollbackByteLimit` to limit terminal scrollback by allocated page bytes, including the active screen. `0` clears history and disables further scrollback. Limits apply to whole pages, and positive byte limits have a minimum based on screen size.

- [#1065](https://github.com/ShaulLavo/fregat/pull/1065) [`48f8cd7`](https://github.com/ShaulLavo/fregat/commit/48f8cd7211cf4e4833e2bf1cf6398cebe1a1ef0b) - Fixed terminal link hovering to save and restore the pre-hover canvas cursor value and CSS priority, while preserving host declarations that differ from `pointer !important` on exit. Terminal output leaves host cursor styles untouched while no link is visible.

- [#1061](https://github.com/ShaulLavo/fregat/pull/1061) [`945fba5`](https://github.com/ShaulLavo/fregat/commit/945fba5f400428e2990de96d3181eb7b9f043c57) - Improved terminal scrolling by reusing unchanged native frame records while preserving cursor, selection, colour, and screen updates in WebGL and WebGPU.

- [#964](https://github.com/ShaulLavo/fregat/pull/964) [`76e4ef7`](https://github.com/ShaulLavo/fregat/commit/76e4ef778442b0b7bcdf048ec4f35229f3a6394b) - Add a headless terminal correctness comparison and dated results.

- [#1025](https://github.com/ShaulLavo/fregat/pull/1025) [`f171549`](https://github.com/ShaulLavo/fregat/commit/f171549d50b71ac58a95249fb9f1b1983fd5d538) - Improved `readTextRows` allocation behavior for accented and CJK terminal text. Text snapshots keep the same text and immutable cell values.

- [#1009](https://github.com/ShaulLavo/fregat/pull/1009) [`b4e5264`](https://github.com/ShaulLavo/fregat/commit/b4e526490217841d304a83b22b4fe987afd44a98) - Reduce copied terminal text snapshot work while preserving accepted-frame text and immutable cell data.

- [#933](https://github.com/ShaulLavo/fregat/pull/933) [`24d5bba`](https://github.com/ShaulLavo/fregat/commit/24d5bba2995db064bf15f1cb311c86bd57b5826b) - Improved WebGPU glyph uploads by removing an intermediate copy of glyph data.

- [#932](https://github.com/ShaulLavo/fregat/pull/932) [`0acaa1a`](https://github.com/ShaulLavo/fregat/commit/0acaa1a46f699d3bf5b6f14a788a2691f9a8c356) - Fixed worker terminal shutdown confirming disposal before GPU cleanup finished. Shutdown now waits for pending device acquisition and recovery, and reports a timeout if cleanup cannot finish, including while the worker is idle.

## 0.3.20

### Patch Changes

- 2de9687: Reuse the last successfully parsed RGB brush during packed Canvas drawing while preserving draw-time errors and alpha.
- 32b822e: Reduce glyph cache key construction in the packed Canvas renderer.
- 039d66a: Project DOM rows directly from owned packed cells and retain lazy immutable styled frame snapshots.
- cb6efff: Reuse unchanged Canvas rows during output and viewport scrolling while preserving full native row reads and appearance invalidation.

## 0.3.17

### Patch Changes

- f78b378: Measure WebGPU through production default device ownership and coordinated submission. Read adapter provenance from the renderer's actual device, and join encoded commands to their submitted group before qualifying presentation feedback.

## 0.3.16

### Patch Changes

- ef362cb: Retain unchanged DOM rows when cursor appearance forwards an equal renderer theme, while refreshing geometry and publishing the cursor frame.
- 324667b: Refresh glyph resources when browser fonts load or fail, including replacements with unchanged fitted metrics.
- a5a8f0e: Build the packed Canvas compositor from Zig with the same memory ownership, RGBA arithmetic, scalar/SIMD modes and Wasm API.

## 0.3.15

### Patch Changes

- 367e5a7: Reject regressing or nonfinite benchmark CPU counters before aggregation and retain the rejected process ID and counter values in the failure message.
- fda88dc: Retain packed Canvas glyph stamps when terminal appearance forwarding updates the theme.
- 0bd8659: Preserve native selection identities across repeated unchanged worker layouts. Keep native operation and result codes in worker failure diagnostics.

## 0.3.14

### Patch Changes

- f45f31d: Share the default WebGPU device across terminals and submit their separate canvas command buffers together in one render turn. Retain independent terminal resources, device leases, and frame snapshots before delivering callbacks.
- 518168b: Acquire a fresh WebGPU device when a terminal worker recovers from device loss.

## 0.3.13

### Patch Changes

- 332cf31: Refresh WebGPU viewport rows after scrolling while retaining unchanged cell and glyph records.
- 833e553: Add an explicit experimental Canvas pixel paint mode with a lazily loaded packed WASM compositor, and preserve native cell ownership in both Canvas paint modes. The main terminal entry accepts the renderer mode; the worker entry reports an explicit capability error for Canvas modes.
- 8d4694a: Use the shared hotkeys dispatcher for terminal focus, named commands and exported default/shell binding packs. Original input claims stay synchronous; generated input reaches the existing main native owner once.
- cddda9a: Pack WebGPU glyph uploads into 80-byte records while retaining native glyph data and atlas generation tracking.
- bd6975b: Reject classic link-provider registration when its validation getter disposes the resolver, keeping the disposed registry empty.
- aba7b9b: Preserve pending accessibility announcements while replaying the displayed frame, and verify submitted accessibility controls across packaged main and worker terminals.
- 8d4694a: Connect terminal hotkeys directly to one owned original-input boundary. Preserve synchronous main-host claims, native modes and independent dispatcher lifetime while keeping general extension registration separate.
- 771dbbe: Upload one bounding changed span per WebGL instance buffer and count the actual requested bytes, preserving native row notifications and full-grid rendering.
- 74ce1a5: Upload one bounding span per changed WebGPU instance buffer and count the actual bytes requested.
- 0cbad9f: Commit the worker canvas CSS dimensions from its fitted frame geometry so high pixel ratios retain the intended display size.
- c2383f2: Connect packaged worker link hover, keyboard discovery and activation to owned native OSC8 and cell snapshots. Keep providers, extension contributions and activation callbacks on the host, reject stale completions after each provider await, and preserve synchronous main-terminal activation.
- 4872bf9: Connect native-owned selection gestures and atomic copy readback to the packaged worker terminal, with synchronous pointer ownership and activation-preserving default clipboard writes.
- e78192e: Publish extension input and event dispatch only for interested handlers, and keep native runtime exports on a shared immutable receiver shape across instances.

## 0.3.11

### Patch Changes

- 7bf879b: Remove trailing whitespace from the ZWJ emoji font license so staged diff checks pass.
- fad6890: Extract local native execution ownership and publish an owned submitted-frame summary for coherent text, cursor and layout observations. Preserve synchronous main-entry authority and commit viewport state before resize observers paint.
- b055a27: Add bounded, generation-tagged custom OSC observation transport from the official native parser through terminal sessions.
- b8ae7a0: Add shared benchmark browser provenance and headed-acceptance guards without changing browser launch flags.
- 74bf7d5: Add the packaged worker terminal source entry and preserve asynchronous key ownership, initial fitted resize events, retained inactive cursor settings and native grids while auto-fit hosts are unmeasurable. Keep atomic output open-only, announce it through accessibility and retain captured geometry when observers reenter. Preserve structured worker opening failures through host cleanup.
- b830dee: Activate public extension presets and typed handles, claim original input before native encoding, and preserve separate keyless text actions after composition commits and cancellation.
- 857159e: Cancel the returned frame handle when a supplied clock disposes the render scheduler during its frame request, releasing queued frame work after teardown.
- de0bf61: Keep worker output announcements pending until a submitted frame includes the posted write. Preserve ordinary, newline and atomic output notifications across queued pre-output frames, and announce newly submitted direct-producer output alongside host writes.

## 0.3.10

### Patch Changes

- c0dc2ac: Skip absent extension contribution groups during attachment. Keep fresh handles and independent disposal while removing empty array creation and traversal for inert extensions.
- e4818e1: Bundle the maintained native compatibility verifier to Node-compatible ESM before launching its Node probe, preserving runtime identity and binary compatibility assertions.
- c4bdd00: Expose native printing-unit text measurement and live terminal geometry, capturing prompt geometry and committing native revisions before observers run.

## 0.3.9

### Patch Changes

- 0df200c: Reuse unchanged Canvas terminal rows through bounded scroll-by-blit, with exact row matching and cursor-safe repainting. Respect scheduled row membership when a render source returns additional rows.
- 2093eff: Gate benchmark renderer frame callbacks during delayed-output controls, including frames queued before the hold. Add real main-terminal, native-worker and xterm hold/release correctness checks.
- 2737859: Pin official libghostty-vt native unknown OSC callbacks and record reproducible WASM provenance.
- fffe237: Add an inactive internal extension lifecycle scaffold with transactional setup, indexed hooks and scoped cleanup. Public activation and performance qualification remain pending.
- 2afc489: Add a deterministic rolling-slow comparison fixture with one viewport-fitting ASCII log line per frame.

## 0.3.0

### Minor Changes

- Add a damage-aware DOM renderer after Canvas2D in the automatic backend chain. Export `renderFrameToHtml` and `snapshotRenderState` for styled terminal frames rendered under Node, sharing live row markup, selection and cursor styling. Frame snapshots retain immutable cell colors and styles. `Terminal.onFrame` reports painted viewport row indices for frame observers. Font fitting uses DOM measurement when Canvas2D is unavailable.

## 0.2.0

### Minor Changes

- Remove the xterm facade and stylesheet exports. Browser integrations use the native `Terminal` from `ghostty-webgpu`, with byte-based PTY traffic and automatic fitting. Remove facade-only declarations, parity tooling, and replacement fixtures.
