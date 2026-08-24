# Renderer refactor baseline

This is the immutable pre-refactor characterization required by Plan 001. Renderer behavior was
measured from base commit `a7e73720fcba4617243f7d6077a4c39dd21799d0` on 2026-08-24 after adding
metrics and the deterministic glyph-churn scenario but before changing instance layouts, glyph
rasterization, atlas sizing, shaders, or public font geometry.

## Environment

| Item               | Value                                                    |
| ------------------ | -------------------------------------------------------- |
| OS                 | macOS 26.4 (25E246), arm64                               |
| Bun                | 1.3.10                                                   |
| Browser            | Chrome for Testing 148.0.7778.96, headed                 |
| WebGPU adapter     | Apple, architecture `metal-3`, hardware Metal adapter    |
| Viewport           | 1600×900 CSS pixels                                      |
| Device-pixel ratio | Browser 2; renderer 1 due to the defect documented below |
| Terminal grid      | 200 columns × 50 rows, 8×16 logical cell                 |
| Warmup             | 5 seconds per scenario                                   |
| Sample             | 30 one-second GPU-process CPU samples per scenario       |

The benchmark identifies Chromium's GPU subprocess and samples its `%CPU` through `ps`. CPU values
are percentages of one logical CPU. The benchmark uses the headed hardware adapter; SwiftShader
results are not substituted. Plan 005 later found that the initial low-level renderer construction
omitted `pixelRatio`, so the browser reported DPR 2 while this initial renderer defaulted to DPR 1.

## Hardware baseline

| Scenario              | CPU mean | CPU median | CPU p95 | CPU max | Frames | Draws | Rebuilt rows | Instance bytes | Atlas hits | Atlas misses | Atlas pages | Atlas evictions | Atlas upload ops | Atlas uploaded bytes |
| --------------------- | -------: | ---------: | ------: | ------: | -----: | ----: | -----------: | -------------: | ---------: | -----------: | ----------: | --------------: | ---------------: | -------------------: |
| focused-blinking-idle |    0.12% |      0.10% |   0.30% |   0.30% |      0 |     0 |            0 |              0 |          0 |            0 |           1 |               0 |                0 |                    0 |
| unfocused-idle        |    0.00% |      0.00% |   0.00% |   0.00% |      0 |     0 |            0 |              0 |          0 |            0 |           1 |               0 |                0 |                    0 |
| burst-output          |    6.70% |      6.60% |   8.00% |   8.40% |  1,808 | 3,616 |       90,400 |  2,314,240,000 | 17,541,216 |            0 |           1 |               0 |                0 |                    0 |
| sustained-scroll      |    6.47% |      6.20% |   7.60% |   8.30% |  1,807 | 3,614 |       90,350 |  2,312,960,000 | 17,531,514 |            0 |           1 |               0 |                0 |                    0 |
| glyph-churn           |   22.94% |     23.20% |  25.50% |  25.60% |  1,160 | 2,320 |       58,000 |  1,484,800,000 |  4,063,058 |       40,006 |           2 |               3 |            1,160 |       19,461,570,560 |

The churn case is the primary atlas-transfer instrument. The current renderer uploaded about
19.46 GB in 30 seconds because every dirty atlas sync rewrote a complete 2048² RGBA texture. Plans
003–004 must reduce that traffic without hiding the counter or changing its meaning.

The focused-blinking scenario submitted no frames during this run because the benchmark terminal's
native cursor was not marked blinking. Keep the scenario unchanged for comparable history; the
renderer browser suite separately proves cursor-blink scheduling and the absence of a standing
animation frame.

## Automated characterization

| Gate                                                        | Result                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `bun run test:unit -- src/render/atlas/tests/atlas.test.ts` | PASS — 5 tests                                                              |
| Focused glyph/text browser tests                            | PASS — 6 tests                                                              |
| `CI=true bun run test:browser`                              | PASS — 67 unique browser tests; supported Linux partition unchanged         |
| `bun run verify`                                            | PASS — 121 unit + 67 browser tests, plus typecheck, lint, format, and build |

The renderer fidelity tests use geometry, coverage, alpha, cache, and draw-count invariants. They do
not compare exact anti-aliased pixels because Canvas font rasterization differs across operating
systems and browser backends.

## Plan 004 texture-array comparison

Plan 004 was sampled three times with the same environment and 5-second/30-second protocol. The
table reports the median of each run's median. Churn bytes are the median total transferred bytes
for the three runs.

| Scenario              | Baseline median | Plan 004 run medians | Three-run median | Result                          |
| --------------------- | --------------: | -------------------: | ---------------: | ------------------------------- |
| focused-blinking-idle |           0.10% |      0.30/0.30/0.30% |            0.30% | FAIL — allowed ceiling is 0.20% |
| unfocused-idle        |           0.00% |      0.00/0.10/0.00% |            0.00% | PASS                            |
| burst-output          |           6.60% |      6.10/6.10/6.20% |            6.10% | PASS                            |
| sustained-scroll      |           6.20% |      6.10/6.10/6.10% |            6.10% | PASS                            |
| glyph-churn           |          23.20% |      6.40/6.30/6.40% |            6.40% | diagnostic improvement          |

Glyph-churn atlas traffic measured 3,476,656, 3,502,241, and 3,490,357 bytes. The 3,490,357-byte
median is 99.98207% below the 19,461,570,560-byte Plan 001 baseline and exceeds the required 90%
reduction. Its CPU median also fell from 23.2% to 6.4%.

The focused-idle miss is isolated to Chromium's GPU subprocess: all three runs recorded zero
submitted frames, draws, rebuilt rows, instance bytes, atlas operations, and atlas bytes. No
renderer work occurred, but the repeated 0.30% process measurement still exceeds the plan's strict
0.20% ceiling. The operator explicitly accepted that measured variance on 2026-08-24 because the
renderer activity counters remained zero; the benchmark threshold itself was not relaxed.

## Corrected DPR2 baseline

Plan 005 calibrated the original renderer in a temporary detached checkout of `a7e7372`. The only
source change passed `pixelRatio: 2` to the old low-level renderer, producing 16×32 device cells and
a 3200×1600 backing surface. Browser, adapter, viewport, grid, scenario order, warmup, sampling, and
GPU-process measurement remained unchanged. The checkout was removed after the results were
captured.

| Scenario              | Run 1 median | Run 2 median | Run 3 median | Corrected baseline median |
| --------------------- | -----------: | -----------: | -----------: | ------------------------: |
| focused-blinking-idle |        0.10% |        0.30% |        0.20% |                     0.20% |
| unfocused-idle        |        0.00% |        0.00% |        0.00% |                     0.00% |
| burst-output          |        8.50% |        8.50% |        8.40% |                     8.50% |
| sustained-scroll      |        8.50% |        8.60% |        8.50% |                     8.50% |

These values supersede the initial CPU figures only for true-DPR2 Plan 005 comparisons. The initial
Plan 001 glyph-churn byte count remains the atlas-transfer baseline: its counter measured fixed
2048² full-texture uploads and is independent of canvas backing size.

## Plan 005 final hardware qualification

Plan 005 was sampled three times with the correct DPR2 fitted-font contract. The table compares the
median of its three run medians with the corrected baseline. The allowed ceiling is the larger of
10% relative or 0.1 percentage point above baseline.

| Scenario              | Plan 005 run medians | Three-run median | Corrected baseline | Allowed ceiling | Result                  |
| --------------------- | -------------------: | ---------------: | -----------------: | --------------: | ----------------------- |
| focused-blinking-idle |      0.30/0.10/0.20% |            0.20% |              0.20% |           0.30% | PASS                    |
| unfocused-idle        |      0.00/0.00/0.00% |            0.00% |              0.00% |           0.10% | PASS                    |
| burst-output          |     15.00/8.90/8.90% |            8.90% |              8.50% |           9.35% | PASS — 4.71% regression |
| sustained-scroll      |     14.90/8.90/8.70% |            8.90% |              8.50% |           9.35% | PASS — 4.71% regression |
| glyph-churn           |     11.90/9.30/9.70% |            9.70% |         diagnostic |      diagnostic | PASS — improved         |

Every idle run recorded zero frames, draws, row rebuilds, instance uploads, atlas operations, and
atlas bytes. Populated frames retained exactly two draws. Glyph-churn atlas traffic measured
66,540,273, 71,423,529, and 72,113,596 bytes; the 71,423,529-byte median is 99.633% below the
19,461,570,560-byte Plan 001 baseline. Atlas layers, glyph cache activity, submitted frames, and row
rebuilds remained bounded by each fixed-duration scenario.

After the benchmark entry was tightened so the raw Ghostty terminal also receives the fitted
16×32 device-cell dimensions, one final full run measured 0.10% focused idle, 0.00% unfocused idle,
9.10% burst, 8.90% sustained, and 9.70% glyph churn. Burst and sustained remain below the corrected
9.35% ceiling. The run retained two draws per populated frame and uploaded 72,006,318 churn-atlas
bytes. `CI=true bun run test:browser` then passed 74 unique browser tests with no new skips, and
`bun run verify` passed 135 unit plus 74 browser tests, typecheck, lint, formatting, and build.
