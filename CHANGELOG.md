# ghostty-webgpu

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
