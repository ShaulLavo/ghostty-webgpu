# Output and input latency attribution

Status: Phase 1 measured and review repairs completed on 2026-10-01. A corrected 17-terminal ASCII CPU rerun supplements the original matrix. The headed Apple M1 matrix covers 1, 8, and 17 terminals, ASCII, SGR, and loopback input echo, with three repetitions and paired trace/control phases. No product fixes were made. Phase 2 remains separate.

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
