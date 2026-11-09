# Complete canvas-image preparation

Status: Approved, prepared in PR 111. This batch selects only complete
`src/dom/tests/canvas-image.browser.test.ts` at merged base
`34378d49718828ba793e15e68e7ffd96ac6aa19d`.

The `canvas-image` stage retains all 38 cases, every original byte and all backend
rows. Test and hook timeouts remain 15,000 ms and 30,000 ms with zero retries.
No renderer, runtime, provider, original, helper, pin, lock or exclusion changes.
Waffle remains published 0.0.111. PR 108 is not consumed.

The source uses actual built Terminal and renderers, direct owned canvas copies,
original TestClock callbacks and real animation frames. Its imported screenshot
helper is unused. No provider screenshot replaces canvas-image observations.
The pixels row loads the existing compositor. Bidi, ligatures and worker
execution are not selected. Monospace is a browser font, not a font download.

Packet and pre-entry evidence are under
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch37/`.
Parent owns independent review, CI acceptance, merge, main CI and native intake.
No native, Mac or Device resources are allocated by preparation.

## Desktop evidence and handoff

Pre-entry root and extension builds, types, 123 normally discovered adapter tests,
lint, repository format, site docs, launcher help and strict driver types passed.
The one complete original execution passed all 38 cases in ordinary headless
Chromium with SwiftShader. This proves desktop correctness, not hardware GPU
performance or native Safari. No retries, skipped rows or exception filters.

The saved graph binds 246 inspected modules, 115 runtime JavaScript modules and
833 input identities. Three actual Wasm responses had the expected media types
and lengths. Scalar compositor, worker entry and terminal-font files were not
requested. Source-derived callback accounting is not an observed assertion or
platform pixel count. Packet verification validates saved data without replay.

Teardown joined the browser, HTTP server and WebSockets, then removed the private
install, generated outputs, temporary driver and scratch. The clean source-only
checkout remains for parent review. Parent retires it with the standard guard
only after every T3 cwd holder releases it. Shared caches and services remain.

Native, whole-root and physical-iPhone completion are unclaimed. Parent owns the
fresh independent review, CI acceptance, merge, main CI and native intake.
