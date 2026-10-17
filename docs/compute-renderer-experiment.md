# Compute renderer experiment

Keep the instanced WebGPU renderer. The final optimized compute-copy comparison showed no clear overall win: instanced rendering won all 12 completed-update capacity pairs, and dense p95 latency regressed beyond observed repeatability. Stop optimization and retain the experimental code on its research branch. This delivery ships benchmark repairs and this report.

The initial rejection was premature. RAF-paced CPU measurements and an isolated GPU timestamp fixture could not establish overall speed. The final decision below uses complete updates and explicit completion and observed-output endpoints.

## Optimized implementation and final comparison

The retained [compute-copy implementation](https://github.com/ShaulLavo/fregat/tree/de6128e940729e4fb6eb278e9dde3212f36bc4aa/ghostty-webgpu) reuses native frame records, atlas textures, row mapping, and frame ownership. It composes dirty pixel bands into an owned texture, then copies that texture into each fresh canvas texture. It supports arbitrary ordered glyph overhang and removal, restores narrow glyph bounds on complete rebuilds, and avoids the fullscreen presentation draw. BGRA output explicitly requires `bgra8unorm-storage`. The portable compute and fullscreen fragment controls remain on the research branch.

The final frozen matrix ran once on Apple M1 Metal in headed Chromium 156.0.8078.4, with one 200-column, 50-row terminal at device pixel ratio 2. Four balanced paired cohorts compared compute-copy with instanced rendering. Separate same-build instanced comparisons supplied the A/A repeatability envelope. That envelope describes finite observed variation, without a statistical-significance claim.

### Maximum completed-update capacity

Each timed batch drains the queue, executes 32 real writes and manual scheduler flushes, and ends at one common GPU queue-completion callback. This measures completed-update capacity, not displayed frames per second. The manual clock uses direct submissions; the latency comparison uses normal RAF and the shared coordinator.

Rates are median updates per second across four cohorts. Paired ratios are medians of the four compute-copy-to-instanced ratios, so they need not equal the ratio of the displayed rates.

| Workload    | Instanced | Compute-copy | Paired ratio | Regression beyond A/A |
| ----------- | --------: | -----------: | -----------: | --------------------- |
| Interactive |   1374.30 |      1076.00 |     0.774198 | No                    |
| Dense       |   1329.84 |       582.37 |     0.442328 | Yes                   |
| Scroll      |   1513.42 |       497.28 |     0.331743 | Yes                   |

All four pairs favored instanced rendering in each workload. The paired capacity reductions were 22.58%, 55.77%, and 66.83%. The interactive reduction remained inside its wide A/A envelope. Dense and scroll reductions exceeded theirs.

### Request-to-observed-output latency

The primary endpoint starts at Node request dispatch and ends when the first compositor PNG with exact final content arrives. It includes dispatch, capture, encoding, and transport. It measures browser-observed output. Physical scanout remains unmeasured.

Each cohort contributes 24 writes per arm and workload. Values below are medians of four cohort quantiles, in milliseconds. Both workloads' p50 differences remained inside A/A variation.

| Workload    | Quantile | Instanced | Compute-copy | Paired change | Regression beyond A/A |
| ----------- | -------- | --------: | -----------: | ------------: | --------------------- |
| Interactive | p50      |    39.813 |       39.446 |        -1.02% | No                    |
| Interactive | p95      |    43.672 |       44.678 |        +1.40% | No                    |
| Dense       | p50      |    39.332 |       39.473 |        -0.14% | No                    |
| Dense       | p95      |    43.873 |       47.156 |        +7.49% | Yes                   |

Dense observed-output p95 exceeded the A/A upper bound of +5.57%. The secondary request-to-queue-callback p95 also regressed: 18.409 ms to 21.477 ms, a paired +16.96% against an A/A upper bound of +15.09%. Queue callback time includes callback delivery. The absolute medians and paired percentage changes use different aggregation orders.

## Earlier measurements remain context

The [original prototype](https://github.com/ShaulLavo/fregat/tree/ebbe34185836e1448620d09d3de3fc7552445a1a/ghostty-webgpu) composed every pixel and presented compute output with a fullscreen draw. A separate headed M1 run completed three repetitions of five RAF-paced scenarios across four renderers, 60 samples in total. Its total Chrome CPU medians below are percentages of one core. Settled idle submitted no frames in any arm.

| Scenario         | Instanced WebGPU | Fullscreen fragment | Compute | Canvas2D pixels |
| ---------------- | ---------------: | ------------------: | ------: | --------------: |
| Cursor movement  |           37.12% |              37.94% |  37.67% |          37.13% |
| Burst output     |           39.87% |              39.03% |  40.43% |          46.78% |
| Sustained scroll |           38.48% |              37.93% |  37.93% |          45.97% |
| Glyph churn      |           73.39% |              74.43% |  75.36% |          92.65% |

An older offscreen timestamp fixture used an 80-column, 24-row dense frame. Median GPU times were 0.362 ms for instanced rendering, 0.809 ms for fullscreen fragment, and 1.787 ms for the original compute path including presentation. Each mode had 72 retained samples. The fixture excluded CPU uploads, canvas context presentation, browser handoff, and physical display latency. These timings describe the original prototype at that endpoint.

[Zutty's compute renderer](https://tomscii.sig7.se/2020/11/How-Zutty-works) assigns independent cell rectangles. Ghostty glyphs can overlap neighboring cells and rows, so the experimental compositor gathers glyphs in logical order. Ferrum's [compute-to-fragment change](https://github.com/itsserbin/ferrum/commit/922d04e458f07d3ac7198781aec4932a87dd5db8) informed the fragment control. Its [sRGB correction](https://github.com/itsserbin/ferrum/commit/653686660b42c880430183ad4bf50b369ac5d111) informed the color checks. Those references explain the design; this library's measurements determine the result.

## Delivery, evidence, and cleanup

The benchmark state wrapper now forwards native frame-builder creation and snapshot version, so WebGPU and WebGL2 paint real frames. The runner serves and hashes the existing Canvas2D pixel WASM asset, reports draw errors, awaits disposal, and checks the selected Canvas2D paint mode. Its default arms and workloads stay unchanged. Experimental runtime code remains outside this delivery.

Final evidence is in `/work/reports/ghostty-compute-20261017/end-to-end/r04/`: `FINAL.md`, `final-summary.json`, `analysis/`, and the frozen `packet/`. `run-final-analysis.mjs` reproduces the offline summaries. The original CPU and timestamp evidence remains in `/work/reports/ghostty-compute-20261017/hardware-mac/`.

The final record preserves failed r02 and r03 validation attempts. Valid r02 A/A controls and 192 r03 retained outputs were reused under the frozen applicability checks. The final repair corrected the native-palette glyph detector and saved qualification screenshots before assertions. Original failures remain recorded as failures. Completed valid windows were not repeated or rescored. Full-image arm comparisons differed by at most one channel step. Qualification also checked stale and no-op exclusion, a real 100 ms paint hold, exact final content, and causal frame and acknowledgement ordering.

The final export verified 1,124 files and 822,596,727 bytes against SHA-256 inventories. Controller teardown and a separate live Mac probe confirmed that the task directory, lock, and owned processes were removed. Existing browser caches were preserved. Local raw evidence remains for report review and archive, with cleanup owned by the coordinator.
