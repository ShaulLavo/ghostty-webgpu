# ghostty-webgpu

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
