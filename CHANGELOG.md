# ghostty-webgpu

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
