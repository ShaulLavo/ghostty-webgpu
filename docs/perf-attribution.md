# Output and input latency attribution

Status: Phase 1 measured and review repairs completed on 2026-10-01. A corrected 17-terminal ASCII CPU rerun supplements the original attribution matrix. Phase 2 implements packed damaged-row snapshots and measures main versus treatment on the Apple M1 at 1 and 17 terminals, ASCII and SGR. The initial matrix has mixed CPU results. A single direct-packed DOM frame follow-up improves CPU in all fresh 17-terminal ASCII/SGR pairs; substantial baseline drift between matrices remains unexplained. The PR stays draft for review. Phase 1's input/echo conclusions remain separate.

## Conclusions and target reproducibility

The corrected baseline is [benchmarks.md](benchmarks.md), from Fregat PR #235. This investigation preserves the CPU disadvantage at 17 terminals, identifies renderer-side snapshot/instance work, and does **not** reproduce the one-terminal input-p95 disadvantage.

| Target                         |     PR #235 native / xterm | This run native / xterm | Measured conclusion                                                                                                           |
| ------------------------------ | -------------------------: | ----------------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| ASCII output CPU, 17 terminals | 100.1% / 89.9% of one core |        106.77% / 86.72% | Native renderer CPU is higher; native GPU-process CPU is lower.                                                               |
| Input echo p95, 1 terminal     |             46.2 / 32.1 ms |        28.83 / 39.75 ms | Native disadvantage did not reproduce. Plan 283's target table may change.                                                    |
| Write p50, 1 terminal          |              14.0 / 8.2 ms |        17.01 / 12.24 ms | Median-of-run gap is 4.77 ms, with overlapping/reversed individual runs. Frame/capture phase dominates the measured endpoint. |

The new summary values are medians of three run-level statistics from **inactive-wrapper controls**. Absolute values are subject to the geometry and instrumentation limitations below. Captured-glyph latency ends at the first compositor screencast PNG containing the intended colored glyph. It is distinct from Chrome presentation feedback and optical display latency.

## Ranked causes and candidate fixes

Shares below use **all measured renderer-main task time** in traced output phases, including the residual outside wrapped boundaries. They are measurements of this workload, not predicted CPU savings.

| Rank / target         | Measured cause                                  | Evidence at 17 terminals                                                                                                                                                                | Proposed next step                                                                                                                                                                                            | Complexity                                                         |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 / output            | Snapshot extraction and JS cell materialization | 49.35% of main tasks for ASCII; 59.25% for SGR. Sampled `get view` leaf time alone is about 11.94% / 15.46% of main tasks, inside this stage.                                           | First test reusing `DataView` and typed memory views while `memory.buffer` identity is unchanged; refresh them after growth. Only consider a bulk snapshot ABI if that simple change leaves substantial cost. | Low for view reuse; medium for ABI/data-layout changes.            |
| 2 / output            | Instance building                               | 26.82% ASCII; 15.61% SGR. Warm glyph/key/color lookup and cell/glyph packing occur here.                                                                                                | Measure and streamline the warm instance path, preserving cell semantics and damage behavior. The trace does not establish a single winning substep.                                                          | Medium.                                                            |
| 3 / output            | JS residual and uninstrumented browser work     | Wrapped JS: 10.20% / 8.79%; uninstrumented residual: 6.12% / 5.98%.                                                                                                                     | Drill down only after snapshot/instance changes; separate recorder overhead from library work.                                                                                                                | Low instrumentation; fix depends on the finding.                   |
| 4 / output            | Buffer upload                                   | 4.16% / 3.67%; 76,800 bytes per native terminal render. Steady-state atlas uploads are zero.                                                                                            | Consider smaller instance uploads only after measuring a row/layout change.                                                                                                                                   | Medium.                                                            |
| Low priority / output | VT parser, damage, command encoding/submission  | ASCII parser 1.33%, damage 0.38%, commands 1.64%. SGR parser 4.89%, damage 0.32%, commands 1.49%.                                                                                       | These are not the first optimization targets. Device sharing/batching needs fresh evidence after the renderer-side work is reduced.                                                                           | Medium/high for device lifecycle and batching.                     |
| 1 / input             | Waiting for renderer frame delivery             | Representative native p95 input: 31.31 ms from parse end to render start, 78.9% of its 39.69 ms captured latency. xterm exhibits the same two-refresh wait.                             | Keep the input target conditional on reproduction; distinguish terminal scheduling from Chromium frame delivery and capture. No native scheduler fix is justified yet.                                        | Low/medium for further instrumentation; product redesign unproven. |
| 2 / input             | Render-to-capture waiting                       | Same sample: 7.20 ms, 18.1%. Terminal work is 0.565 ms.                                                                                                                                 | Stabilize/characterize the capture endpoint before assigning the historical p95 gap to terminal code.                                                                                                         | Low/medium investigation.                                          |
| 1 / write             | Capture/frame phase                             | Representative native middle write: render finishes at +0.465 ms; glyph capture is +10.860 ms. The post-render interval is 95.7% of this sample. Other repetitions enter a later frame. | Preserve paired endpoint/timeline measurements before choosing a write-latency product fix. Snapshot/instance optimization addresses measured output work, but does not explain the entire control write gap. | Low/medium investigation.                                          |

The dominant output problem is the **snapshot/instance data boundary and layout**, not demonstrated GPU saturation. `src/core/memory.ts` constructs a new view in each `view`/`bytes` getter; cell reads use these views and multiple WASM ABI getters. That source observation and sampled leaf evidence make view reuse the smallest first experiment. No change or after-speedup is claimed here.

## Hardware, qualification, and window geometry

Authoritative measurements ran on the owner's Apple M1 MacBook Air, Darwin 25.4.0 arm64, headed Chromium 153.0.8010.12, Playwright 1.63.0, and ANGLE Metal on Apple M1. WebGPU and WebGL were hardware enabled. Each separate count window checked `pmset -g batt` for AC power and ran under `caffeinate -d -u -t 1800`. Windows took approximately 5–7 minutes each, below the 30-minute bound.

Qualification measures the **idle display**, immediately before terminals mount on the same measured page/window. The runner brings the page to front, warms up for 1 second, samples 120 rAF intervals with an 8-second deadline, and requires visibility `visible` plus a median within ±10% of 16.67 ms. Occasional skipped frames and p95 around 33 ms are accepted. Focus, visibility, intervals, bounds, page/count/phase identity, and errors are saved before the assertion. A rejected idle window keeps its qualification diagnostics and discards its timing data. Mounted/streaming cadence is workload evidence and never a display rejection criterion.

| Terminals | Empty-page probes |  Idle median range | Maximum mounted-probe median | Result    |
| --------: | ----------------: | -----------------: | ---------------------------: | --------- |
|         1 |                 6 | 16.6725–16.6875 ms |                    16.945 ms | Qualified |
|         8 |                 6 | 16.6725–17.5450 ms |                    17.510 ms | Qualified |
|        17 |                 6 | 16.6700–16.6825 ms |                   16.9325 ms | Qualified |

Each window retains 48 probes: six idle-display probes and 42 mounted-workload probes. All phase error fields are empty. Earlier rejected rehearsals supply no timing conclusions in this document.

The native display is 1440 × 900 CSS pixels at DPR 2. The physical window is positioned at (16,16), outer 1408 × 868, with content 1408 × 781. The original 17-terminal grid is 1544 × 1332 and cannot fit at full scale. A compositor-placement CSS transform fits **both** libraries on-screen: scale 1 at count 1, 0.90673575 at count 8, and 0.58033033 at count 17. Logical host dimensions, 40 columns × 12 rows, bundled JetBrains Mono regular/bold, 12 px font, line-height 1.2, and every terminal's 560 × 456 canvas backing dimensions stay unchanged. The runner checks backing dimensions before/after fitting and checks every transformed terminal rectangle.

This changes physical compositor area and presentation geometry relative to PR #235. It limits absolute cross-run CPU/capture comparisons; the library-side snapshot, instance, and ownership observations remain directly measured. Native and xterm screenshots at all counts are in the evidence directory; they were read back for visible output and on-screen placement. Linux SwiftShader smoke supplies correctness evidence only, with no timing claims.

## CPU by Chromium process

### Correction after review

The original v4 CPU numerator spanned two process snapshots, but its denominator covered only the operation between them. In traced phases, recorder activation sat between the first snapshot and the operation timer. Those intervals differ. **The original v4 CPU percentages and trace/control CPU ratios are unqualified and withdrawn from the conclusions.** The original 17-terminal ASCII controls reported 109.19% native and 88.75% xterm. Their archives contain neither snapshot acquisition timestamps nor matching CDP events; the exact interval cannot be reconstructed. The compact v4 rows now explicitly carry `cpuIntervalQualified: false`. Their independent renderer-main task shares, counters, and captured latency samples remain usable.

The replacement is a narrow headed M1 rerun of 17-terminal ASCII, three repetitions with alternating control/trace order, on AC under `caffeinate -d -u -t 1500`. It ran from 12:10:10.926 to 12:13:27.609 UTC. All six cases, twelve phases, and 24 display probes completed without run, page, or phase failures. Six idle medians span 16.6700–16.8725 ms; the largest mounted median is 17.1250 ms. The original on-screen geometry, terminal dimensions, real GPU, browser version, and fixtures are retained. Both replacement screenshots were read back.

Recorder activation now precedes the first CPU snapshot. Each snapshot retains its CDP request and response timestamps. CPU is `SystemInfo.getProcessInfo` CPU-time delta divided by the midpoint-to-midpoint interval of those acquisition brackets; operation duration is stored separately. CDP supplies no exact internal acquisition timestamp, so midpoint timing is an estimate with explicit uncertainty: half the combined request/response bracket widths. Across this rerun that uncertainty is 0.371–0.862 ms on intervals of 3062.7–3090.1 ms (less than 0.029%). This bounds clock acquisition uncertainty; it is not a correction for workload or profiling perturbation. Process births/exits still reject a sample.

Percentages are percent of one core. Renderer includes all renderer-process CPU. GPU-process CPU is CPU consumption in that process, **not GPU hardware execution time**. Columns are independently aggregated medians and need not sum exactly.

| ASCII, 17 terminals | Native total | Native renderer | Native GPU process | xterm total | xterm renderer | xterm GPU process |
| ------------------- | -----------: | --------------: | -----------------: | ----------: | -------------: | ----------------: |
| Controls            |       106.77 |           80.66 |              25.86 |       86.72 |          49.31 |             37.23 |
| Traced              |       114.90 |           86.09 |              28.45 |       96.29 |          61.40 |             35.01 |

Control totals by repetition are native 106.19, 106.77, 107.14%; xterm 86.72, 97.79, 85.86%. The corrected median gap is 20.05 percentage points. Native excess remains renderer-side, while native GPU-process CPU is lower. This rerun replaces only 17-terminal ASCII CPU; 1/8-terminal and SGR CPU figures have not been remeasured. The differences from v4 include ordinary run-to-run variation as well as the interval repair, so the numerical change cannot be assigned solely to that repair.

### Tracing perturbation

Trace/control order alternates by repetition. Wrappers are installed on `?trace` pages but recording is inactive in controls, so these are not default no-wrapper controls. Chrome tracing, CPU sampling, method wrapping, counters, and span allocation perturb the workload. In this corrected run, total medians rise from 106.77 to 114.90% native and 86.72 to 96.29% xterm, while xterm GPU-process CPU falls from 37.23 to 35.01%. A universal positive overhead subtraction is invalid. Use controls for comparative CPU and traces for attribution; do not multiply a traced stage share by control CPU to predict savings.

The corrected ASCII trace independently confirms the stage ranking: native snapshot 49.14%, instances 27.16%, parsing 1.31%, and residual 5.93% of 7017.70 ms summed renderer-main tasks. The full 1/8/17 stage matrix below is the original v4 task-time evidence, whose denominator does not use process CPU sampling.

## Exclusive renderer-main task attribution

`comparison-attribution.mjs` aligns the `compare/begin` UserTiming timestamp with its `performance.now` time, selects that renderer's main pid/tid, clips complete `RunTask` intervals to the recording window, and unions overlaps. Nested wrapper spans subtract child duration from parent self-time. The tables divide summed category self-time across three repetitions by summed whole-main task time. Residual includes unwrapped browser work, GC, and recorder overhead outside boundaries. `summary.shares` in raw records has a different, instrumented-only denominator and is not used for these tables.

### Native shares, percent of whole main tasks

| Output | Count | Parse | Snapshot/copy | Damage | Instances | Upload | Commands |    JS | Residual | Main-task ms, 3 runs |
| ------ | ----: | ----: | ------------: | -----: | --------: | -----: | -------: | ----: | -------: | -------------------: |
| ASCII  |     1 |  1.00 |         55.16 |   0.24 |     17.09 |   2.49 |     1.37 |  7.90 |    14.75 |              1870.64 |
| ASCII  |     8 |  1.21 |         49.87 |   0.38 |     25.17 |   3.82 |     1.58 | 10.04 |     7.93 |              4046.85 |
| ASCII  |    17 |  1.33 |         49.35 |   0.38 |     26.82 |   4.16 |     1.64 | 10.20 |     6.12 |              7163.94 |
| SGR    |     1 |  4.41 |         51.52 |   0.34 |     13.02 |   3.17 |     1.65 |  9.44 |    16.46 |              1657.32 |
| SGR    |     8 |  4.70 |         58.26 |   0.33 |     15.16 |   3.61 |     1.46 |  8.64 |     7.83 |              4160.41 |
| SGR    |    17 |  4.89 |         59.25 |   0.32 |     15.61 |   3.67 |     1.49 |  8.79 |     5.98 |              7565.66 |

### xterm shares, percent of whole main tasks

| Output | Count | Parse | Model/instances | Damage | Upload | Commands |   JS | Residual | Main-task ms, 3 runs |
| ------ | ----: | ----: | --------------: | -----: | -----: | -------: | ---: | -------: | -------------------: |
| ASCII  |     1 | 44.79 |            4.21 |   0.36 |   1.28 |     1.06 | 2.92 |    45.38 |              1185.77 |
| ASCII  |     8 | 66.56 |            5.26 |   0.19 |   1.20 |     0.93 | 2.33 |    23.52 |              2360.77 |
| ASCII  |    17 | 70.48 |            5.19 |   0.20 |   1.25 |     0.87 | 2.37 |    19.65 |              4010.12 |
| SGR    |     1 | 48.28 |            4.31 |   0.32 |   1.26 |     1.07 | 2.69 |    42.08 |              1224.18 |
| SGR    |     8 | 70.14 |            4.47 |   0.14 |   1.08 |     0.80 | 1.95 |    21.41 |              2465.44 |
| SGR    |    17 | 71.23 |            4.53 |   0.15 |   1.17 |     0.81 | 2.04 |    20.07 |              4385.55 |

### Boundaries and sampled drill-down

| Category      | Native boundary                                                 | Pinned xterm WebGL boundary                   |
| ------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Parse         | Exact `ghostty_terminal_vt_write` WASM call                     | Input handler `parse`                         |
| Snapshot/copy | Render-state `update` and `readRows`                            | `_updateModel`, including model/instance work |
| Damage        | `rowsToRebuild` and state `acknowledge`                         | Render service `refreshRows`                  |
| Instances     | `rebuildRows`, excluding nested snapshot calls                  | Included in `_updateModel`                    |
| Upload        | Text pass `upload`, atlas `sync`                                | `bufferData`, `texImage2D`                    |
| Commands      | Text pass `submit`                                              | `drawElementsInstanced`, explicit `flush`     |
| JS            | Exclusive core/DOM `write`, `notifyWrite`, `drawFrame` residual | Exclusive `write`, `renderRows` residual      |

WASM ABI getters during cell extraction belong to snapshot, not VT parsing. xterm combines model and instance work, so its model share is not a matching native snapshot-only boundary. Private pinned xterm methods fail immediately if missing.

Chrome sampled profiles join `ProfileChunk` events by renderer pid and profile identity; chunks arrive on sampler threads. Native `get view` leaf estimates across three repetitions are 855.49 ms ASCII / 1169.76 ms SGR at count 17, and 556.67 / 636.27 ms at count 8. These are sampling estimates inside the snapshot path, not exact boundary durations or extra shares to add to the table. Function-name leaf aggregation cannot fully separate identically named functions or attribute all GC.

## Per-terminal/render counts and resource ownership

Each output phase has 180 paced writes. The clear/settle render adds one: each terminal has 181 renders per repetition, or 543 across three repetitions. Counts remain consistent at 1, 8, and 17 terminals. Compact analyses preserve terminal-specific distributions of exact counter combinations; full archives preserve each raw timestamped count and frame.

| Observable per terminal render     |         Native |                  xterm WebGL |
| ---------------------------------- | -------------: | ---------------------------: |
| State/model updates                |              1 |                            1 |
| Copied/model rows                  |             12 |                           12 |
| Copied cells                       |            480 | Unavailable at this boundary |
| Buffer writes                      |              2 |                            3 |
| Buffer bytes, ASCII average        |         76,800 |                    19,570.39 |
| Buffer bytes, SGR average          |         76,800 |                    10,425.19 |
| Draws                              |              2 |                            3 |
| WebGPU queue submissions           |              1 |    Unavailable through WebGL |
| Explicit GL flushes                | Not applicable |                   0 observed |
| Steady-state atlas uploads / bytes |          0 / 0 |                        0 / 0 |

xterm's first clear frame uploads 1280 bytes; full steady ASCII/SGR frames upload 19,672 / 10,476 bytes. Native counts are fixed in these fixtures. These values count API upload bytes, not downstream driver copies. Atlas initialization happened before recording; zero warm uploads does not mean zero atlas memory or zero glyph-cache lookup cost.

At count 17, native aggregate work for one shared rendering group is 17 state updates, 204 rows, 8160 cells, 34 buffer writes, 1,305,600 uploaded bytes, 34 draws, and 17 queue submissions. Across three output repetitions there are 9231 terminal renders for either library; count 8 has 4344 and count 1 has 543.

| Count | Native schedulers / devices / queues / pipelines | xterm debouncers / GL contexts / programs |
| ----: | ------------------------------------------------ | ----------------------------------------- |
|     1 | 1 / 1 / 1 / 2                                    | 1 / 1 / 2                                 |
|     8 | 8 / 8 / 8 / 16                                   | 8 / 8 / 16                                |
|    17 | 17 / 17 / 17 / 34                                | 17 / 17 / 34                              |

One benchmark pacing rAF stream is additional to those terminal scheduling owners. Native terminals share one WASM runtime, but do not share GPU devices/queues. WebGL explicit flush is not equivalent to WebGPU submission; no zero-submission claim is made for xterm.

The analyzer assigns each render span once to its last containing Chrome `AnimationFrame`, then sums independent terminal callback duration in that frame. At count 17, native ASCII median work is 11.47–11.87 ms across repetitions, p95 12.35–13.61 ms, maximum 27.03 ms; SGR median is 11.96–12.10 ms. At count 8, native ASCII medians are 6.44–6.58 ms. xterm count-17 render-callback medians are about 0.61–0.66 ms, but its parsing runs outside these callbacks: this is not a total-CPU comparison. Paced output median intervals remain approximately 16.67 ms, with skipped/stretching frames retained as workload data.

## Input and write timelines

All latency phases have 24 write and 24 input samples per repetition. Input begins at captured keydown, crosses the loopback WebSocket echo, then parses/renders. Write begins at browser write. The analyzer converts captured epoch timestamps through `performance.timeOrigin`, finds the sample's parse/render/command spans, and joins `AnimationFrame::Presentation` to the **containing renderer frame's identity**, never a nearby global GPU event.

### Control latency matrix, milliseconds

| Count | Native write p50 | xterm write p50 | Native input p95 | xterm input p95 |
| ----: | ---------------: | --------------: | ---------------: | --------------: |
|     1 |           17.010 |          12.239 |           28.827 |          39.752 |
|     8 |           20.756 |          16.827 |           25.466 |          27.922 |
|    17 |           20.950 |          16.103 |           26.788 |          31.098 |

One-terminal control write p50 by repetition is native **17.010, 17.952, 10.432**, versus xterm **21.710, 9.864, 12.239**. Input p95 is native **40.082, 23.919, 28.827**, versus xterm **40.369, 39.752, 25.150**. This variance and reversed runs prevent a deterministic claim about the original write gap. The historical native input-p95 disadvantage is absent in this matrix.

### Representative traced samples

Times below are milliseconds after operation start, from repetition 0. A middle write is the upper-middle observed sample in a 24-sample run; the reported run p50 averages the middle pair. A p95 input is the nearest-rank sample. Raw latency traces for both libraries are checked in.

| Event                                | Native middle write, index 15 | xterm middle write, index 11 | Native p95 input, index 25 | xterm p95 input, index 28 |
| ------------------------------------ | ----------------------------: | ---------------------------: | -------------------------: | ------------------------: |
| Echo received                        |                             — |                            — |                      0.700 |                     0.370 |
| Parse start / end                    |                 0.075 / 0.090 |                0.215 / 0.350 |              0.755 / 0.760 |             0.395 / 0.430 |
| Render start / end                   |                 0.245 / 0.465 |                0.510 / 0.740 |            32.070 / 32.490 |           32.315 / 32.390 |
| Final submission/draw call end       |                         0.415 |                        0.740 |                     32.260 |                    32.390 |
| Captured glyph                       |                        10.860 |                        8.496 |                     39.691 |                    40.351 |
| Matched Chrome presentation feedback |                        26.926 |                       23.660 |                     55.831 |                    56.473 |
| Exclusive terminal work              |                         0.320 |                        0.390 |                      0.565 |                     0.115 |

Native input identity is `4ab6eb2b08eca0f1`, xterm input identity `f4483463d242a913`. Native middle-write identity is `4ab6eb2b08ecbe8e`, xterm `f4483463d242b470`. Chrome feedback is about a refresh later than glyph capture here; these are different observables, not an optical presentation claim.

For the native p95 input, `RequestAnimationFrame` occurs at +0.804 ms. The external display callback/BeginFrame arrives at +14.327/+14.384 ms, but `SendDidNotProduceFrame` at +14.387 ms reports numeric reason 1. Pipeline sequence 1144 is `BACKFILL` / `STATE_DROPPED` at +15.167 ms, with `has_main_animation: true`. There is no renderer-main task spanning that refresh; tasks after input finish by +1.717 ms. The next `ProxyMain::BeginMainFrame` arrives at +32.008 ms and the intended terminal render starts at +32.070 ms. Thus the missed boundary is measured, and main-thread parsing/render CPU does not occupy that gap. **The lower-level Chromium skip reason is unconfirmed**; numeric reason 1 is not translated into a causal label. xterm's p95 sample similarly reaches its first renderer boundary at +32.165 ms.

The native middle write renders within 0.5 ms and spends 10.395 ms waiting from render end to captured glyph. Native repetition 2's middle write instead starts rendering at +10.240 ms and captures at +18.807 ms. Scheduling/capture phase varies; sub-millisecond terminal work does not explain a fixed 4.77 ms control gap.

Across all 72 traced one-terminal samples per operation, component medians are:

| Variant / operation |  Echo | Parse end | Render start | Render end | Capture | Chrome feedback | Terminal work |
| ------------------- | ----: | --------: | -----------: | ---------: | ------: | --------------: | ------------: |
| Native write        |     — |     0.105 |        0.757 |      1.270 |  12.114 |          28.137 |         0.388 |
| xterm write         |     — |     0.160 |        0.460 |      0.613 |   9.452 |          27.358 |         0.140 |
| Native input        | 0.588 |     0.615 |       14.885 |     15.373 |  23.036 |          38.967 |         0.488 |
| xterm input         | 0.460 |     0.532 |       15.565 |     15.643 |  23.310 |          39.042 |         0.125 |

These are separate marginal medians, not an additive synthetic sample. Traced latency is perturbed and does not replace control p50/p95. Optical latency, GPU execution duration, the lower-level skipped-frame cause, and a reproducible native-only input scheduling disadvantage remain unconfirmed.

## Evidence and provenance

[Checked-in evidence](benchmarks/mac-m1/attribution-2026-10-01/) contains the corrected rerun in `cpu-corrected-17-ascii/` (compact analysis, both repetition-0 raw Chrome traces, and both screenshots), plus `analysis-1.json`, `analysis-8.json`, `analysis-17.json`, repetition-0 ASCII raw Chrome traces for both libraries at each count, repetition-0 one-terminal latency raw traces, and screenshots at all counts. Compact analyses retain CPU process deltas, whole-main attribution, sampled leaves, all sample timelines, per-terminal counts/ownership, exact frame-counter distributions, qualification metadata, and SHA256 of every full trace and `comparison.json`. Raw qualification intervals are represented by their SHA256 in compact files and retained in full archives.

The measured portable manifest records base commit `d2d01354729989e585ffed681648eedd77b1eb9f` plus dirty tracing-tool changes, source SHA256 `20920b8944e6bcf8f8a02e37cda67d5ace635f5fd3fb7772faa33b04286e228c`, and browser-bundle SHA256 `0aabe0cec8971d67e863c6c8e1ce43357b7f62a2a8981e121603ed2b9fbcd169`. The manifest records versions and fixture hashes. The final postprocessor subsequently added compact output and unique containing-frame assignment; those offline changes did not alter the measured browser bundle. Actual tracing overrides are 180 output writes and 24 samples per latency operation, independent of normal comparison defaults in the manifest.

The corrected portable manifest records clean commit `4b307474e5a6d3919765649a8e5819df9d6d5719`, source SHA256 `99073816515ec1837746f12d8f48db4f16b1ce33394e65662a5bbabc4c6824db`, and browser-bundle SHA256 `2eece08b080a6f89e349609dac823a57f3a1ce348cfb784782dd59a9c7138336`. Its bundle and full run remain on the Mac at `~/tmp/gw-bench/attribution-bundle-v5` and `~/tmp/gw-bench/attribution-mac-17-ascii-v5`.

Full raw archives are outside git at `/work/reports/ghostty-benchmarks/plan-283/`. Their source directories and the measured portable bundle remain on the Mac at `~/tmp/gw-bench/attribution-mac-{1,8,17}-v4` and `~/tmp/gw-bench/attribution-bundle-v4`.

| Archive                              | SHA256                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| `attribution-mac-1-v4.tar.gz`        | `46294c30cc2d0ca7352318b88512375d49b68165956ecd6e5e51bd58d1d46b1e` |
| `attribution-mac-8-v4.tar.gz`        | `bcbd206e32b8ecb297972b51e504a4a7d62abf7bfa451130505cc001b1de4737` |
| `attribution-mac-17-v4.tar.gz`       | `52b57bad8f8e1d46035a1f1547dbd31d193b0cbc764784854ec174ae361bb87e` |
| `attribution-mac-17-ascii-v5.tar.gz` | `a7a5faa48038b7afc2ed28c876f51225a619c3d2521f8c895ca198b371a2f9a7` |

## Reproduction and verification

Tracing is off by default; only benchmark `?trace` installs wrappers. Consumer/library source is unchanged. Recording activates between `traceBegin` and `traceEnd`; UserTiming serialization occurs after the CPU snapshot. Supported flags are `--trace`, `--trace-count 1|8|17`, `--trace-phase latency|ascii|sgr` (default all three), `--trace-frames N` (default 180), `--trace-latency-samples N` (default 48), and `--display-awake`. `--smoke --smoke-instrumentation` checks wrappers without producing hardware performance claims.

From the package directory on Linux, build the established portable bundle:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
nice -n 19 taskset -c 0-7 bun run bench:compare -- \
  --build-only --bundle /work/tmp/plan-283/bundle
```

Ship it using the existing portable runner transfer procedure; its `node_modules` uses the runner's already-installed pinned dependencies at `~/tmp/gw-bench/node_modules`. Use one fresh output directory per count, one `mesh mac -- sh -c '<cmd>'` session, and a bounded window. On the Mac:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
pmset -g batt | command grep 'AC Power' || { echo 'waiting for AC'; exit 1; }
cd ~/tmp/gw-bench/attribution-bundle
caffeinate -d -u -t 1800 node comparison-runner.mjs \
  --trace --trace-count 1 --trace-latency-samples 24 --display-awake \
  --output ../attribution-mac-m1-1
```

Repeat for counts 8 and 17. Reproduce the corrected narrow rerun with `--trace --trace-count 17 --trace-phase ascii --display-awake` in a fresh output directory. Fresh directories are required only for tracing, which owns discard-on-failure. Ordinary comparison reruns reuse their output directory and qualify the idle display at its measured refresh period, including 120/144 Hz. Trace windows on the Mac require idle 60 Hz qualification. Mounted cadence remains workload evidence, but hidden pages, probe errors, and missing/invalid samples reject the window. Expired probes cancel their own rAF callback and cannot append samples or pacing markers to a later probe. Recompute full/compact attribution from any full qualified directory:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
nice -n 19 taskset -c 0-7 node scripts/comparison-attribution.mjs \
  /work/tmp/plan-283/attribution-mac-1-v4 /work/tmp/plan-283/analysis-1.json --compact
nice -n 19 taskset -c 0-7 bun run bench:compare:test
nice -n 19 taskset -c 0-7 bun run typecheck
```

All 44 narrow tooling tests pass. They cover matched CPU acquisition intervals and asynchronous timing uncertainty, run/page failures and incomplete case/phase evidence, numeric option validation and compact CLI parsing, awaited and bounded trace cleanup, stale refresh cancellation, reusable ordinary outputs, portable temporary roots, and display qualification versus workload cadence, diagnostic retention/cleanup, process churn and trace-stream closure, nested-exclusive counters, terminal/frame isolation, ownership identities, clock alignment and main-task union, sampled-profile identity, unique frame aggregation, presentation identity, and compact-evidence preservation. The analyzer rejects failed or unfinished windows before publishing rows, and verifies the selected case matrix, trace/control pairs, sample counts, and display probes. A case deadline awaits context closure and trace finalization; stalled drain has a ten-second give-up and stops the entire window. Package/portable builds, repository pre-commit gates and typechecks, and Linux native/xterm byte/string smoke also passed. The existing `bench:compare:test` entry now includes tracing, attribution, and option regressions through its test imports; pinned package metadata and native-resolver provenance remain unchanged. Seven existing package lint warnings remain outside the changed files. The first repair push passed Ghostty CI jobs; the repository package job failed in unrelated Raspberry Pi tests because CI checks out shallow history (`fregatCheckout` cannot find `3d86637e8`, followed by two lane-lock child-process failures). Product deployment, product fixes, optical measurements, and merge are deliberately outside this Phase 1 delivery.

## Phase 2: packed damaged-row snapshots

### Data boundary and upstream API

The bulk reader moves the per-cell WASM boundary into our existing `bridge.wasm`. One `bridge_read_rows` call iterates requested or damaged rows and writes a reusable packed workspace. A new largest grapheme payload requires one capacity-growth retry; subsequent reads reuse that allocation. JavaScript copies the populated records into owned typed arrays, so returned snapshots survive writes, memory growth, resize, and disposal. Damage acknowledgement remains a separate operation.

The source is official Ghostty at `c8554f28e0efe2f5595f32020371c34b25ec628f`. `GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW` supplies the contiguous borrowed `GhosttyCellsView`. The bridge uses `ghostty_cell_get` for codepoint, content tag, styling presence, and width, plus the official row/cell accessors for resolved colors, styles, graphemes, and row-local selection. It avoids decoding upstream raw-cell bit positions, which are outside the stable ABI contract. Ghostty is unpatched; rebuilding with `bun run build:wasm --source <clean-pinned-checkout>` reproduces the unchanged `ghostty-vt.wasm` and the new bridge.

| Record           |     Size | Fields, in order                                                                            |
| ---------------- | -------: | ------------------------------------------------------------------------------------------- |
| Snapshot header  | 36 bytes | Row pointer/capacity/length; cell pointer/capacity/length; grapheme pointer/capacity/length |
| Row              | 16 bytes | Viewport y, dirty flag, first cell index, cell count                                        |
| Cell             | 24 bytes | Codepoint, foreground RGB, background RGB, flags, grapheme index, grapheme length           |
| Grapheme element |  4 bytes | Unicode codepoint; a cluster contains its base and subsequent codepoints                    |

All fields are little-endian u32 values. RGB is `r | g << 8 | b << 16`; `0xffffffff` means an unset explicit color. Cell flags use bits 0–1 for width, bit 2 for selection, bit 3 for styling presence, bits 4–11 for bold/italic/faint/blink/inverse/invisible/strikethrough/overline, and bits 12 onward for underline style. This layout belongs to our bridge, independent of Ghostty's private raw-cell layout.

WebGPU and WebGL request packed rows. `InstanceRows` reads the records with one reusable scratch cell per row and never materializes a cell array. Public `readRows()` retains owned object snapshots by default; a packed row's `cells` getter materializes lazily for inspection. The initial treatment also invokes that getter for DOM frame data. The targeted follow-up derives frozen text/continuation arrays directly from packed records for caret, links, and accessibility, preserving the existing frame contract. Canvas rendering uses the public object shape and the shared frame helper, with extraction still supplied by the bulk bridge. Wide-cell spans retain the previous continuation scan.

The bridge imports Ghostty's memory and C exports. Its stack is a separately allocated, 16-byte-aligned 64 KiB region, freed with the runtime. The bridge has no memory-initializing data section; a regression test verifies that instantiation leaves existing Ghostty memory intact.

### Correctness

The complete package unit suite passes 354 tests. Five bulk-reader tests include forty seeded random screens compared against the previous per-cell reader on the same native render state. They cover wide text, combining and ZWJ graphemes, palette and truecolor values, every supported style, selection, viewport changes, retained-state dimensions after resize, empty first reads, damaged/requested row filtering, allocation growth, and owned snapshot lifetime. The instance-builder comparison requires equal cell/glyph buffers and throws if the packed path reads the materialized `cells` array. Thirteen built-API Chromium history and pointer-selection tests and twenty-five WebGPU/WebGL renderer browser tests also pass. Two existing Linux SwiftShader device-replacement success/retry cases are skipped. Repository pre-commit gates and typechecks pass.

### Main versus packed snapshots on Apple M1

The initial treatment is measured commit `201ed6ee9298ad3ac06ed79d66f18f62737c15a0`, against main at `24a6f3d04290fb37311fd0fa9c50777ca953d8a0` (PR #245 included). Each condition uses three alternated pairs, AB/BA/AB, with native and paired pinned xterm WebGL controls in every invocation. CPU values below are independently aggregated medians of inactive-wrapper controls, in percent of one core. Traces use 180 paced writes plus one clear render. No CPU-rate improvement is inferred from a smaller snapshot share.

| Count / output | Native renderer before → after | Native total before → after | xterm renderer before → after | xterm total before → after |
| -------------- | -----------------------------: | --------------------------: | ----------------------------: | -------------------------: |
| 1 / ASCII      |                  23.73 → 23.00 |               36.44 → 37.41 |                 20.92 → 19.56 |              36.50 → 34.93 |
| 1 / SGR        |                  24.91 → 23.10 |               37.63 → 37.52 |                 19.89 → 20.90 |              36.27 → 35.74 |
| 17 / ASCII     |                107.84 → 113.42 |             155.89 → 179.98 |                 79.53 → 83.30 |            142.44 → 160.30 |
| 17 / SGR       |                 104.62 → 96.14 |             154.29 → 146.52 |                 93.02 → 87.10 |            168.65 → 161.13 |

**Losses:** 17-terminal ASCII renderer CPU rises 5.58 percentage points and total CPU rises 24.09 points; all three paired native rate deltas lose. One-terminal ASCII total CPU rises 0.97 points. The 17-terminal SGR medians improve, but repetition 0 loses: renderer +8.53 points and total +24.84 points. xterm controls also vary, particularly at 17 terminals, so three pairs establish an observed result rather than a confidence interval or isolated causal effect. Native after-treatment renderer CPU remains higher than its paired xterm median in all four conditions.

The paced 180-write workloads have different elapsed times when frames stretch. CPU rate measures utilization per wall-clock second; CPU seconds measure consumption for the fixed work. They answer different questions. Values below are separate medians, not an additive synthetic run.

| Count / output | Native elapsed ms before → after | Native renderer CPU seconds before → after | Native total CPU seconds before → after | xterm after renderer / total CPU seconds | Native GPU-process CPU before → after |
| -------------- | -------------------------------: | -----------------------------------------: | --------------------------------------: | ---------------------------------------: | ------------------------------------: |
| 1 / ASCII      |                3079.87 → 3078.68 |                              0.731 → 0.708 |                           1.123 → 1.151 |                            0.602 / 1.076 |                         12.45 → 13.71 |
| 1 / SGR        |                3073.29 → 3077.66 |                              0.762 → 0.712 |                           1.153 → 1.156 |                            0.643 / 1.101 |                         12.65 → 13.95 |
| 17 / ASCII     |                4191.14 → 3590.36 |                              4.520 → 4.209 |                           6.633 → 6.476 |                            2.706 / 4.979 |                         48.17 → 62.90 |
| 17 / SGR       |                3877.41 → 3086.28 |                              3.970 → 2.959 |                           5.854 → 4.509 |                            2.680 / 4.958 |                         47.65 → 54.74 |

GPU-process CPU is process CPU consumption, not GPU execution time. The lower fixed-work CPU seconds at 17-terminal ASCII coexist with higher CPU rates and a shorter output interval. This does not satisfy an unqualified claim that the CPU-rate disadvantage is fixed.

### Whole-main attribution and migrated work

The sums below cover all three traced runs. Shares use whole renderer-main task time, including uninstrumented residual. Trace perturbation prevents extrapolating these percentages into control CPU savings.

| Count / output | Snapshot share before → after | Snapshot ms before → after | Instances ms before → after | JS ms before → after | Snapshot + instances + JS ms before → after | Whole-main ms before → after |
| -------------- | ----------------------------: | -------------------------: | --------------------------: | -------------------: | ------------------------------------------: | ---------------------------: |
| 1 / ASCII      |                22.44% → 6.59% |             170.73 → 43.48 |             141.17 → 141.10 |      135.26 → 149.38 |                             447.16 → 333.96 |              760.90 → 659.31 |
| 1 / SGR        |                26.11% → 7.34% |             223.21 → 52.86 |              99.14 → 110.06 |      147.53 → 167.00 |                             469.87 → 329.92 |              854.75 → 720.23 |
| 17 / ASCII     |                39.21% → 5.51% |           5680.76 → 670.31 |           4656.72 → 5916.82 |    1932.16 → 2892.23 |                          12269.64 → 9479.36 |          14486.55 → 12156.12 |
| 17 / SGR       |                47.22% → 7.06% |           6997.83 → 722.16 |           2988.71 → 3603.48 |    1893.92 → 2601.25 |                          11880.47 → 6926.90 |          14819.77 → 10229.93 |

Snapshot extraction shrinks, while packed text/style decoding moves into instances and DOM frame consumers materialize cells under JS. Both stages rise at 17 terminals. Their combined absolute time falls 22.74% for ASCII and 41.70% for SGR; whole-main task time falls 16.09% and 30.97%. Those trace reductions are real within the recorded boundaries, but they are not evidence of a universal process CPU-rate win.

The targeted 17-ASCII sample-stack inspection measures inclusive `copiedFrameRow` work at 71.58 / 92.53 / 79.69 ms before and 257.72 / 312.00 / 311.48 ms after. The summed increase is 637.41 ms, with after materialization/getter descendants accounting for about 512.33 ms. Total after frame-copy work is 7.25% of whole-main task time. GC leaf samples rise 162.29 → 408.09 ms, but these CPU traces measure neither allocation bytes nor which prior allocator caused a collection. This identifies a concrete avoidable cost to test; it does not prove that removing it fixes the process CPU regression.

### Qualification, parity, and provenance

The owner’s Apple M1 MacBook Air uses headed Chromium 153.0.8010.12, Darwin 25.4.0 arm64, and ANGLE Metal. WebGPU is hardware-enabled with a non-fallback adapter. Every one of 24 invocations records an AC-power check, each condition holds the display with `caffeinate -d -u -t 1800`, and exclusivity is checked before its window. Windows take 9.97 minutes (17 ASCII), 9.34 (17 SGR), 4.67 (1 ASCII), and 4.50 (1 SGR), each below 30 minutes. All 48 idle-display probes qualify; process CPU acquisition intervals qualify. The PR #245 on-screen transform, backing dimensions, fonts, grid, fixtures, and browser are matched. Mounted cadence remains workload evidence.

All native counters and ownership totals match: 181 terminal renders, 2172 rows and 86880 cells per terminal per trace; each render copies 12 rows / 480 cells, writes two buffers totaling 76800 bytes, draws twice, submits once, and uploads no warm atlas data. One saved baseline 17-ASCII repetition-2 frame summary mislabels its first two rows, despite correct raw spans and terminal-tagged counters. The validator reconstructs the exact per-frame distributions from those raw records, verifies 181 matching frames per terminal, and retains the saved-summary discrepancy in `matched-work-checks.json`. Its cause in the persisted summary is unconfirmed; raw records are authoritative for this check.

The established runner captures the shared correctness fixture before output only in repetition 0. Native PNG bytes match main for both counts in both condition windows, and all eight before/after PNGs were read back: ASCII, foreground colors, wide text, combining text, emoji and overwrite output are visible, with all 17 terminals placed on-screen. These are correctness-fixture screenshots, not distinct ASCII/SGR endpoint captures. Repetitions 1 and 2 retain matching correctness records but no PNGs; no all-repetition screenshot claim is made.

[Compact evidence and reproduction inputs](benchmarks/mac-m1/packed-snapshot-2026-10-01/) include eight analyses, per-run CPU values and timings, raw-window hashes, before/after manifests, matched-work checks, stack sampling, and screenshots. The 336 MiB full archive remains at `/work/tmp/plan-283-fix2/corrected/raw-evidence.tar.gz` and the Mac’s `~/tmp/gw-bench/p283-bulk-snapshot/corrected/raw-evidence.tar.gz`, SHA256 `dd0cd5413ba27110590a210a443b36372689e0d16db476a3c84663866980d350`. Faulty damage-scratch runs and every overlapping duplicate-session matrix are excluded.

The frozen treatment source SHA256 is `0e8b7fb53e29b68a403e589e46146e2376469ef06ecdd97a060f67be1fd8f933`; its browser bundle is `511fca66a42d2d8b8da47dec9ae30057a096170c6cc8cc6cf40c42dce01f36ae`. Baseline carries the equivalent tracing-counter change only. Control assets and portable runners are byte-identical; only the native browser source/bundle and `bridge.wasm` change. The pinned upstream `ghostty-vt.wasm` SHA256 remains `dfb171587bc11b6610fb95d3b583926d51287f5d6e528c45ff2aa05218608a97`; bridge SHA256 is `e2e1fb9a1b6d36f6b8ee4aa7e615e5bc6aeefda69f494832317b46fdea84241a`.

To reproduce offline, extract the full archive into a fresh evidence root, set `root` in the supplied Python inputs to that path, run `combine.py`, run the checked-in `scripts/comparison-attribution.mjs <condition-directory> <condition-directory>/analysis.json --compact` for all eight combinations, then run `summarize.py`, `validate-matched.py`, and `profile-frame.py`. `method.json`, the paired runner and window script preserve the hardware protocol. Use the heavy scheduler for browser/build/trace work.

### Targeted follow-up: direct-packed DOM frame text

The only follow-up changes `copiedFrameRow` to read text and continuation flags directly from packed cells, retaining its frozen row/cell/continuation arrays for caret, link and accessibility consumers. Three real-terminal differential cases compare the former materialized mapping against the direct path and object fallback, reject access to the lazy `cells` getter, and verify retained frame data after memory growth, resize, writes and disposal. The complete suite now passes 357 unit tests and 66 Chromium browser tests covering terminal UI, history, pointer selection, WebGPU and WebGL; the same two SwiftShader device-replacement cases remain skipped. Package build/typecheck and repository commit gates pass.

Measured candidate `04b2d2437e8366b3c703c457f8dd07c19b9e979d` is compared with the same frozen main bundle at `24a6f3d04` in a **fresh** two-condition AB/BA/AB matrix. The following values belong exclusively to that rerun; the initial matrix above is retained in full.

| 17-terminal output | Native renderer before → after | Native total before → after | xterm renderer before → after | xterm total before → after |
| ------------------ | -----------------------------: | --------------------------: | ----------------------------: | -------------------------: |
| ASCII              |                  70.75 → 50.11 |              100.84 → 81.68 |                 53.85 → 51.95 |              94.28 → 91.83 |
| SGR                |                  72.59 → 46.89 |               99.67 → 80.15 |                 54.41 → 54.16 |              91.97 → 93.88 |

Native renderer/total rate deltas are negative in all three pairs: ASCII renderer −21.54 / −18.50 / −20.15 percentage points, total −17.53 / −14.79 / −19.78; SGR renderer −25.70 / −23.64 / −25.57, total −19.96 / −15.44 / −19.52. These are materially larger than the changes in paired xterm controls. Native after-treatment renderer medians are below xterm in both conditions, but ASCII repetition 2 remains above its paired xterm renderer, 50.59% versus 48.71%. xterm total CPU rises in ASCII repetitions 1/2 and SGR repetition 2. Three pairs remain observations rather than confidence intervals or a general parity claim.

| 17-terminal output | Native elapsed ms before → after | Native renderer CPU seconds before → after | Native total CPU seconds before → after | xterm after renderer / total CPU seconds | Native GPU-process CPU before → after |
| ------------------ | -------------------------------: | -----------------------------------------: | --------------------------------------: | ---------------------------------------: | ------------------------------------: |
| ASCII              |                3097.93 → 3070.30 |                              2.201 → 1.541 |                           3.130 → 2.511 |                            1.598 / 2.823 |                         29.95 → 31.18 |
| SGR                |                3074.35 → 3074.20 |                              2.233 → 1.442 |                           3.065 → 2.465 |                            1.665 / 2.886 |                         27.08 → 32.93 |

**Remaining losses:** native GPU-process CPU rises in both conditions. SGR instance work rises 73.64 ms across the three traces. Total process CPU nevertheless falls in every native pair. CPU rates, CPU seconds and elapsed work stay separate observables; GPU-process CPU remains a CPU measure, with no GPU execution-time claim.

| 17-terminal output | Snapshot share before → after | Snapshot ms before → after | Instances ms before → after | JS ms before → after | Snapshot + instances + JS ms before → after | Whole-main ms before → after |
| ------------------ | ----------------------------: | -------------------------: | --------------------------: | -------------------: | ------------------------------------------: | ---------------------------: |
| ASCII              |                39.52% → 6.10% |           2318.40 → 226.63 |           1905.83 → 1903.75 |      717.35 → 610.88 |                           4941.59 → 2741.26 |            5865.90 → 3714.14 |
| SGR                |                47.81% → 8.34% |           2917.76 → 281.19 |           1224.68 → 1298.33 |      687.50 → 593.76 |                           4829.94 → 2173.27 |            6102.48 → 3372.95 |

These are absolute sums across three traced runs. Snapshot extraction shrinks; instance decoding remains, with SGR migration into that stage. Combined snapshot/instances/JS and whole-main time fall in both conditions. The control CPU measurements establish the observed utilization improvement; snapshot share alone does not establish it.

Fresh ASCII sample stacks expose `copiedFrameRow` inclusive totals of 13.67 ms for main and 2.15 ms for the candidate, with no named materialization/getter descendants in the candidate. GC leaf samples are 98.85 → 108.00 ms. Sampling and inlining limit named-function attribution; these traces measure neither allocation bytes nor causally attributable GC. The getter-rejection differential tests establish the eliminated materialization path independently of samples.

**Cross-matrix limitation:** the byte-identical main bundle's ASCII renderer CPU shifts 107.84% in the initial matrix to 70.75% in the fresh matrix; xterm shifts 79.53% to 53.85%. Main's trace frame-copy samples also shrink substantially. Recorded browser/OS/hardware, launch flags, baseline source/bundle hashes, versions, settings, fixtures and assets match; the cause of this broader performance shift is unconfirmed. Clock/thermal state is unavailable. The fresh matrix compares the complete packed-plus-frame treatment with main, and does not isolate the incremental frame change from the first packed implementation under identical conditions. Consequently, 113.42% → 50.11% across the two treatment matrices is **not** attributed to the frame-copy change. The fresh paired improvement meets the observed 17-ASCII CPU bar in this window; its reproducibility across operating conditions remains open for review.

Both exclusive windows record AC before/after all twelve invocations, hardware Metal with a non-fallback WebGPU adapter, unchanged idle-display qualification, and `caffeinate -d -u -t 1800`. ASCII takes 6.31 minutes and SGR 6.26 minutes. All 24 idle probes and CPU acquisition intervals qualify. Counters, raw per-frame distributions, grid, ownership and correctness records match; this rerun has no persisted-frame-summary discrepancy. The four captured native repetition-0 correctness-fixture PNGs are byte-identical to main and were read back, showing the same colored/wide/combining/emoji/overwrite fixture with all 17 terminals on-screen. These are fixture screenshots, with the same capture limitations as the initial matrix.

[Follow-up evidence and reproduction inputs](benchmarks/mac-m1/packed-snapshot-2026-10-01/frame-optimized/) retain four compact analyses, every pair, manifests, power/window records, parity checks, sampled stacks, cross-matrix checks and PNGs. The 227 MiB raw archive remains at `/work/tmp/plan-283-fix2/frame-optimized/raw-evidence.tar.gz` and the Mac's `~/tmp/gw-bench/p283-bulk-snapshot/frame-optimized/raw-evidence.tar.gz`; verified transfer SHA256 is `049eb6f2ea03d47310cfc276dca180c1e4a303b83dd4fc7d38e054ff48ca9f0b`. Candidate source SHA256 is `7dffdb328db33f62da70a4d22dc0da22aa0a2aaf9af0fdbdbdbc46795a802dc7`, browser bundle `26e60e4a8f78c8f048e4aa5ec112dcd88324426130116e28a56ba18234dc97de`; both WASM hashes remain unchanged from the initial packed treatment. Reproduction uses the same supplied offline pipeline with these four combinations.

After measurement, current main is merged normally into the task branch to settle CI gate-list integration drift; main's files are retained and the frozen measured implementation is identified separately from the resulting PR head. No further optimization or hardware condition is added. The PR remains draft for review. One-terminal targets are not rerun after the frame change; input echo, idle workload, parse-only and memory targets are not remeasured. Production deployment and PR merge are outside this delivery.
