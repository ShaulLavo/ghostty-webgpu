# Per-terminal visibility

The DOM host observes its terminal root with an IntersectionObserver. It combines element intersection with document visibility before calling the renderer's existing visibility gate or sending the worker's `visible` command. That gate cancels pending paints and cursor blink timers. Parsing, fitting, and appearance changes continue. Native damage and renderer invalidation remain pending until the scheduler resumes.

`renderWhenOffscreen: true` skips intersection observation in both entries. Document visibility still applies. This supports consumers that intentionally render outside the viewport. The default saves work for scrolled or clipped panes. IntersectionObserver reports asynchronously and does not detect another element covering the terminal.

The accessibility mirror and `visibleLines()` continue to read submitted state. Output timing uses the same effective visibility as painting so a hidden burst waits for the terminal to return. Disposal disconnects the observer before disposing the renderer.

## Correctness

The baseline at `607eacf8830cb9230cf80184160a44b1c6d5f520`, whose product source matches `d2ed8989a745f016188e0a2e749009b3e1450f33`, fails all seven backend cases. Each emits one frame for a write after leaving the viewport, where zero were expected.

The browser regression covers WebGPU, WebGL2, Canvas fill-text, Canvas pixels, DOM, worker WebGPU, and worker WebGL2. It checks suppressed frames and scheduler requests, live native text, retained displayed text and accessibility text, hidden font/theme/size changes, and exactly one submitted repaint on return. Additional cases cover the opt-out, clipping ancestors, immediate writes, cursor timers, document visibility during reentry, and output timing waiting for the returning paint.

At the original PR checkpoint, the rebuilt visibility suite passed all 14 cases. The broader gate passed 231 tests across eight affected browser suites. The unit gate passes 1,106 Vitest tests, 482 benchmark-tool tests, and four checkpoint tests. Build, typecheck, lint, formatting, and the site docs check pass. Screenshots were inspected at original resolution.

## Hardware measurement

The existing `bench:renderer` runner accepts `BENCH_TERMINALS=16`. Four equal-sized terminals intersect the viewport; twelve are below it. Every terminal receives the same updates. The workload includes wide and combining characters, an emoji sequence, and italic text. The runner counterbalances source order and compares delivered bytes, live text from all terminals, and screenshot hashes covering the four displayed panes.

Measured on PC, Linux, i7-14700K, RTX 3060 Ti, headed Chromium 153.0.8010.12. ANGLE reports NVIDIA OpenGL ES 3.2, driver 615.78.08. The shared runner held a quiet benchmark slot, and free VRAM passed the 2 GiB guard before launch.

The source pair is `607eacf8830cb9230cf80184160a44b1c6d5f520` before and `6473f1c46ff713a066c76d52db49b4c152f87ecc` after. The benchmark entry from the candidate is used for both source arms. Wasm and bridge hashes match. Four counterbalanced pairs each deliver 120 burst updates after 20 warmup updates, with 1,228,800 measured bytes per arm.

| Measurement                                     |  Before |   After | Change |
| ----------------------------------------------- | ------: | ------: | -----: |
| Median browser-process CPU, percent of one core | 14.8434 | 11.6177 | -21.7% |
| Scheduled frame requests per sample             |   1,920 |     480 |   -75% |
| Submitted terminal frames per sample            |   1,920 |     480 |   -75% |
| Pending frames at sample end                    |       0 |       0 |  Equal |

CPU samples before are 14.844, 14.346, 14.843, and 14.856 percent. After samples are 10.900, 11.399, 11.853, and 11.836 percent. No sample reports process churn. Every pair has equal live-text and displayed-pixel SHA-256 hashes. The existing runner marks the run performance-qualified. These results describe this host and burst workload.

The recorded `columns` and `rows` metadata captured the initial 80 by 24 grid before fitting. The measured canvas is 930 by 280 device pixels with 15 by 40 cells, a fitted 62 by 7 grid. Both arms have identical dimensions and pixels. The final benchmark records grid metadata after the initial fit settles; this metadata-only correction does not change the measured workload.

Reproduce with a worktree at the before checkpoint and run the candidate tooling:

```sh
BENCH_TERMINALS=16 BENCH_BACKENDS=webgl2 BENCH_SCENARIOS=burst-output \
BENCH_REPETITIONS=4 BENCH_STEPS=120 BENCH_WARMUP_STEPS=20 \
BENCH_BASELINE_ROOT=/path/to/before-worktree \
BENCH_OUTPUT=/path/to/hardware.json bun run bench:renderer
```

Use the shared heavy runner's `--class bench --quiet` mode and the hardware preflight from the wave brief. Raw receipts are retained at `/work/reports/ghostty-webgpu-next-2026-10/f8/`, including the before/after bundles, JSON, logs, and screenshots. Task-created browsers exit, and the baseline and implementation worktrees are removed after the PR is pushed.

## Review fixes

The reviewed `fefb995549a9d77f97719bd8569790b9f5ca39e3` checkpoint treated `isIntersecting` as proof of visible pixels. Chromium can retain that flag for zero-size targets and for edge-only contact. The default threshold also misses some transitions between positive and zero visible area.

The shared host now requires positive element and intersection width and height. A positive epsilon threshold reports the viewport-edge transition. A border-box ResizeObserver restarts intersection observation when size changes, forcing a current geometry entry even when the intersection flag and ratio stay unchanged. Disposal disconnects both observers. The opt-out skips both.

The failing-first matrix adds zero width, zero height, zero size, and viewport-edge cases across all seven backend paths. All 28 cases fail on the reviewed implementation with `expected 1 to be +0`. With the fix, the visibility suite passes 46 cases. All seven return-to-view screenshots match the original PR screenshots byte for byte. The matrix also checks suppressed scheduler requests and text publication, retained submitted text, continued native parsing, and one current-state paint on return. Viewport-edge cases resume with only one pixel visible. Four control cases retain painting for collapsed and edge-touching main/worker terminals when opted out.

Review-fix gates passed build, typecheck, lint, formatting, the site docs check, 1,106 Vitest tests, 482 benchmark-tool tests, and four checkpoint tests. The seven companion browser suites passed 219 tests, for 265 browser cases total with the visibility suite.

`docs/api.md` now states the default and opt-out for both entries beside the submitted-frame/accessibility contract. It covers continued parsing and layout changes, retained submitted text and accessibility, suppressed frame notifications, repaint on return, and asynchronous intersection limits. Review-fix logs are retained under `/work/reports/ghostty-webgpu-next-2026-10/f8/review-fixes/`. This correctness follow-up adds no new performance claim; the audited hardware result above remains the original measured checkpoint.
