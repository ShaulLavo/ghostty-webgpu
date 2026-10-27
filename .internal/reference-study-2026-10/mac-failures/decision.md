# M1 browser failure investigation

Status: Approved. Lane: mac-failures. Date: 2026-10-27.

## Scope and source

Investigate the held-output xterm reference failure and the Unicode ASCII screenshot-height failure on headed M1 Chromium with `GHOSTTY_BROWSER_HARDWARE=1`. Current-main control is `4fe209d30f82d09afd92e335c6220ac8c24531c1`. Frozen dependencies include xterm 6.0.0, its WebGL addon 0.19.0, Playwright 1.63.0 and Vitest 5.0.2.

Raw logs, probes and the original-resolution xterm screenshot are under `/work/reports/ghostty-webgpu-next-2026-10/mac-failures/`. The first staging command accidentally archived the shared checkout at `d2ed8989a745f016188e0a2e749009b3e1450f33`. Those older-control logs are retained and labeled separately. All current-main conclusions use a second archive made from this lane's worktree.

## Xterm reference failure

The unchanged current-main test returns `[0, 0, 0, 255]` instead of `[41, 91, 151, 255]` before DEC 2026 begins. The displayed screenshot contains the correct color in a half-sized rectangle at the wrong position. This is not a parsing or hold-timing failure.

A runtime probe records DPR 1, a 288×124 CSS canvas and a 576×248 ResizeObserver device-pixel box. Xterm's WebGL canvas consequently has a 576×248 drawing buffer but retains viewport `[0, 0, 288, 124]`. The colored cell occupies x=12–17, y=78–92 rather than the expected column 3, row 2. Reading the first canvas captures the composed display through the transparent link layer; it does not explain the misplaced cell.

The addon accepts the observed physical size in `WebglRenderer._setCanvasDevicePixelDimensions`, resizes the canvas and requests a redraw. It does not update the WebGL viewport. The viewport update is in `GlyphRenderer.handleResize`, which this path never calls. Headed Retina Chromium's native device-pixel box remains at scale 2 despite Playwright's emulated DPR 1, exposing that upstream resize bug.

The narrow workaround adds `--force-device-scale-factor=1` only for headed macOS Chromium in the browser test config. This makes native device pixels agree with the suite's existing DPR-1 screenshot coordinates. The xterm reference and its hold/release assertions remain unchanged. Production code and benchmark launch settings are unchanged. A ready-to-file upstream report is in `/work/reports/upstream-bugs/README.md`, under the Retina xterm viewport entry.

The new browser geometry regression fails first on the Mac with `expected [[640, 160]] to deeply equal [[320, 80]]`. With the launch setting it passes, and all 62 cases across geometry, held-output and Unicode pass on the same hardware surface.

## Unicode height finding

The historical failure is a test layout bug. At the older control, a paragraph with platform-dependent normal line height places the canvas at y=50.5. Its CSS height and backing height are both 72, but the element screenshot covers 73 rows because its crop encloses fractional boundaries. The observed bounds are x=0, y=50.5, width=640, height=72, bottom=122.5.

PR #24 already fixes this at `474ca675357dc548ec7f002031997232d82c17a5` by assigning a 20px label line height. Two bounded unchanged-current-main attempts both pass the ASCII cases on WebGPU and WebGL2. Investigation stops on this finding as requested. No second fix, retry, skip or changed pixel expectation is needed. The full 58-case Unicode file also passes with the xterm launch workaround.

## Execution and choices

The Mac adapter was `ANGLE Metal Renderer: Apple M1` under Chromium 153. The Mac was on AC power, with no owner reservation and a free agent lock. One task-owned lock serialized all Mac work. The lane created one copied checkout, disposable browser contexts, logs and probe scripts. The PC verification uses the shared heavy queue. The binding brief prohibits subagents; the coordinator owns independent review, CI and merge.

Fix Root Causes led to inspecting the actual device-pixel observation and GPU viewport before changing launch configuration. Laziness Protocol kept the fix to one launch argument rather than modifying the reference renderer or its pixel sample. Prove It Works required a failing Mac regression and the unchanged hold/release and Unicode tests passing on the same host.

The only blocking resource is the Mac hardware lock. There is one implementation stream because this is a small browser-configuration fix. No new types or function boundaries are needed; the existing ResizeObserver entry carries the geometry. Architect fan-out and separate comment review are skipped under the binding brief's no-delegation rule.

## Verification and cleanup

On the M1, the new geometry regression fails before the fix with `expected [[640, 160]] to deeply equal [[320, 80]]`. The unchanged xterm hold test fails with `expected [0, 0, 0, 255] to deeply equal [41, 91, 151, 255]`. With the launch argument, the final focused hardware run reports `Test Files 3 passed (3)` and `Tests 62 passed (62)`. A separate minimal xterm-only viewport reproducer fails before and passes after the launch setting.

PC build, typecheck, lint, format check, unit tests and site docs checks pass. Node Vitest reports 1,132 passed and one skipped; the additional comparison/checkpoint tests pass. The full PC browser run fails with 10 failed files, 54 failed tests, 1,020 passed and five skipped. Its Linux launch arguments are unchanged by this PR. An unchanged-main control at `4fe209d30` also fails with 10 failed files and 55 failed tests, while GitHub run 40519288134 passes the same SHA. The full failure list and PC/CI browser and font inventories are recorded separately at the coordinator's request in `/work/reports/ghostty-webgpu-next-2026-10/mac-failures/pc-main-failures.md`. The coordinator will assign any confirmed PC environment failure separately; this lane does not fix it.

Mac cleanup is checked on the Mac itself. The 789 MiB copied checkout, both source archives, probes, logs and owned lock are removed. No Chromium, Vitest or browser-test processes remain there. The evidence copies stay on the PC for coordinator review. The new regression is capability-gated only on browsers that lack `devicePixelContentBoxSize`; Chromium executes it, with no new skip on the tested Mac or PC.
