# M3 and M4 comparison

Status: paced M3 complete; matched forced-completion follow-up pending. M4 complete with geometry rejection. Experimental results, 2026-10-27.

## Verdict

Wraith's native worker pipeline has a real, workload-specific throughput advantage, with higher total CPU cost. For 16 terminals running OpenTUI plasma, the same 64 updates finish in 1097 ms versus our WebGPU's 1527 ms on PC, and 1347 ms versus 2275 ms on M1. That is 1.39x and 1.69x faster delivery. Total browser CPU time rises from 2.345 to 3.135 seconds on PC and from 2.555 to 3.649 seconds on M1, increases of 34% and 43%. This is an experimental delivery result, not physical display latency.

It is not a general dense-path win. For 16-terminal NTCharts heatmap, delivery times are similar and Wraith uses 55% more CPU time on PC and 65% more on M1. The apparent one-terminal logging benefit in raw CPU percentages disappears when normalized to the same delivered work. Longer measurement windows can make a CPU-rate percentage look better without reducing total CPU time.

The plasma advantage is already visible at parse acknowledgement. In the PC forward arm, p50 acknowledgement for 16 terminals is 14.1 ms for ours and 2.4 ms for Wraith. GPU record size and font rasterization cannot explain a gain that occurs before rendering. Wraith has 16 dedicated workers and devices; our entry shares one main-thread runtime and device. The cohort compares whole pipelines and does not isolate harfrust/swash or the compact 20-byte record.

- **X5/E7:** keep the bounded experiment and its 20% dense-CPU reduction gate. M3 finds a dense latency win, so the plan's blanket demotion condition is not met. It does not justify adopting compact records. Match parser/worker ownership before crediting the record layout. X4's worker-topology experiment has stronger evidence here.
- **C2:** keep run shaping as the planned capability work. This cohort provides no qualified Unicode visual speed result and no reason to replace the browser font path for CPU performance.
- **General row map:** do not port it on this evidence. Partial-region scrolling and insert/delete lines have no end-to-end CPU win after normalization. At 16 terminals, Wraith costs 1.78x/1.97x our WebGPU CPU time on PC and 2.85x/3.10x on M1 for those two fixtures. An isolated retained-row experiment could still identify a smaller benefit hidden by the worker/device ownership cost.

## Paced results

Each cell is the median of two counterbalanced repetitions. CPU seconds cover the whole browser process family for **64 delivered updates per terminal**, not a CPU-rate percentage. Lower CPU time means less work for that stream. Wall time includes the paced callbacks and final settling. All four entries received the same bytes in the same order. Unicode-varied ran and its text agrees, but its timings stay in the raw packet because fallback-font pixels are not qualified.

### PC, 1 terminal

| Workload            | ours GPU CPU s | ours GL CPU s | xterm GL CPU s | Wraith CPU s | ours GPU / Wraith wall ms |
| ------------------- | -------------: | ------------: | -------------: | -----------: | ------------------------: |
| ntcharts-heatmap    |          0.255 |         0.160 |          0.205 |        0.235 |               1098 / 1097 |
| opentui-plasma      |          0.275 |         0.210 |          3.270 |        0.290 |               1091 / 1095 |
| sustained-logs      |          0.215 |         0.130 |          0.250 |        0.220 |               1095 / 1096 |
| sparse-edits        |          0.170 |         0.090 |          0.120 |        0.210 |               1090 / 1096 |
| synchronized-frames |          0.205 |         0.140 |          0.210 |        0.190 |               1096 / 1089 |
| partial-scroll      |          0.180 |         0.125 |          0.115 |        0.190 |               1099 / 1097 |
| insert-delete-lines |          0.170 |         0.125 |          0.175 |        0.215 |               1100 / 1098 |

### PC, 16 terminals

| Workload            | ours GPU CPU s | ours GL CPU s | xterm GL CPU s | Wraith CPU s | ours GPU / Wraith wall ms |
| ------------------- | -------------: | ------------: | -------------: | -----------: | ------------------------: |
| ntcharts-heatmap    |          1.410 |         0.965 |          1.005 |        2.190 |               1094 / 1100 |
| opentui-plasma      |          2.345 |         1.935 |          5.250 |        3.135 |               1527 / 1097 |
| sustained-logs      |          1.090 |         0.465 |          0.760 |        1.580 |               1092 / 1098 |
| sparse-edits        |          0.700 |         0.205 |          0.395 |        1.455 |               1100 / 1092 |
| synchronized-frames |          1.445 |         0.775 |          0.645 |        1.595 |               1097 / 1088 |
| partial-scroll      |          0.855 |         0.350 |          0.370 |        1.525 |               1089 / 1091 |
| insert-delete-lines |          0.745 |         0.185 |          0.365 |        1.465 |               1093 / 1089 |

### MAC, 1 terminal

| Workload            | ours GPU CPU s | ours GL CPU s | xterm GL CPU s | Wraith CPU s | ours GPU / Wraith wall ms |
| ------------------- | -------------: | ------------: | -------------: | -----------: | ------------------------: |
| ntcharts-heatmap    |          0.381 |         0.358 |          0.440 |        0.494 |               1124 / 1350 |
| opentui-plasma      |          0.329 |         0.359 |          5.389 |        0.462 |               1126 / 1358 |
| sustained-logs      |          0.313 |         0.276 |          0.422 |        0.333 |               1123 / 1364 |
| sparse-edits        |          0.283 |         0.237 |          0.346 |        0.398 |               1111 / 1107 |
| synchronized-frames |          0.315 |         0.286 |          0.507 |        0.361 |               1118 / 1342 |
| partial-scroll      |          0.287 |         0.258 |          0.284 |        0.352 |               1108 / 1389 |
| insert-delete-lines |          0.299 |         0.256 |          0.302 |        0.344 |               1113 / 1452 |

### MAC, 16 terminals

| Workload            | ours GPU CPU s | ours GL CPU s | xterm GL CPU s | Wraith CPU s | ours GPU / Wraith wall ms |
| ------------------- | -------------: | ------------: | -------------: | -----------: | ------------------------: |
| ntcharts-heatmap    |          1.507 |         1.535 |          1.720 |        2.493 |               1247 / 1317 |
| opentui-plasma      |          2.555 |         2.495 |          8.809 |        3.649 |               2275 / 1347 |
| sustained-logs      |          0.662 |         0.774 |          1.540 |        1.591 |               1124 / 1297 |
| sparse-edits        |          0.428 |         0.506 |          0.996 |        1.405 |               1109 / 1105 |
| synchronized-frames |          1.031 |         0.980 |          1.548 |        1.624 |               1113 / 1251 |
| partial-scroll      |          0.589 |         0.730 |          0.758 |        1.675 |               1138 / 1358 |
| insert-delete-lines |          0.496 |         0.514 |          0.802 |        1.535 |               1104 / 1309 |

## Output and frames

All paced text groups agree after padding Wraith's omitted trailing blank rows to the known 30-row viewport, then trimming trailing U+0020 on each row. Leading/interior whitespace, row boundaries, combining text and ZWJ sequences remain unchanged. Each 16-terminal arm also checks every terminal against its peers.

All matched entries have 700 by 570 physical backings, with 7 by 19 cells. The viewport is 3360 by 2560 CSS pixels, fitting all 16 sections without rescaling. On PC, the heatmap has 399000 painted pixels in every crop. Our WebGPU, our WebGL2 and xterm decoded crops are identical. Wraith differs at 13 pixels, with a maximum two-level color difference. Plasma is not pixel-identical at half-block edges: Wraith's procedural blocks and our browser-rasterized blocks differ there. All 6000 upper/lower half-cell interior color samples match exactly. Full-resolution crops were inspected. These limits are part of the experimental cadence result.

Native submitted-frame counters and Wraith render-event counters are retained before/after every workload. In 16-terminal plasma, native records 64 submissions per terminal. Wraith's observed deltas are 64..65; they include the forced text-qualification draw outside timing, so approximately 63..64 are workload draws. Equal final output and delivered bytes do not prove every intermediate presented image. The counters rule out a large reduction in rendered work as the explanation for the plasma delivery gap.

## Completion follow-up

Parse acknowledgements, frame intervals and GPU completion are separate endpoints. The initial `pc-fenced*` and `mac-fenced*` files are **scheduled-presentation diagnostics**, not a matched force-draw comparison. They wait for our next scheduled frame but invoke Wraith's immediate `flush()`. Their large readiness gap includes that policy difference and must not be reported as GPU execution time. The corrected follow-up will force our scheduler to draw and then await `GPUQueue.onSubmittedWorkDone()`, matching Wraith's force-draw-plus-fence endpoint. Its paired PC/Mac numbers will be added separately.

One initial PC fenced 16-terminal Wraith arm was rejected by the existing 80% GPU-utilization guard before its first fixture was retained. The reverse arm passed. That failure remains in `pc-fenced-16/results.json`; it is not replaced with a faster sample. All paced arms passed.

## Scope and method

This follows M3 and M4 in `next-steps.md` from `origin/plan/renderer-next-2026-10`. Runtime source starts at ghostty-webgpu `d2ed8989a745f016188e0a2e749009b3e1450f33`. No product renderer changes are included.

Wraith is `betterclever/wraithterm@115106931ce4934db6bc41f4d7939eb80551d248`, through native `Wraith.mount`, with one dedicated worker per terminal. Its xterm wrapper is excluded from the bundled entry. The prebuilt engine is the revision's checked-in artifact. NimbleMarkets is `nm-webgpu@bfbe0e5c82b12d1f7cfde9784877fbf3a2c9ddc9`, with its own patch applied to Ghostty `6590196661f769dd8f2b3e85d6c98262c4ec5b3b` and compiled by Zig 0.15.2. The resulting 625239-byte core has SHA-256 `53e131008bde7744b9244768918f0f22966eaf35f0c2ef53e5209059bab49f27`, exactly matching lane 07b's successful build. Xterm is `@xterm/xterm@6.0.0` with `@xterm/addon-webgl@0.19.0`.

The grid is 100 columns by 30 rows, DPR 1, with the same JetBrains Mono font file. Wraith receives the lossless SFNT conversion of the browser's WOFF2. Its public line-height option targets our fitted physical cell height. All entries request 10000 lines of history. Our core also has its normal 64 MiB byte budget. Wraith's dedicated-worker and device ownership differs from our shared main-thread runtime and device. These are end-to-end entry comparisons, not an isolated test of record size or font rasterization.

The retained native-only smoke ran first, in headed Chromium 153.0.8010.12, on NVIDIA RTX 3060 Ti with driver 615.78.08. It passed text qualification and reported NVIDIA Ampere with `fallback: false`. The browser's ANGLE renderer also names the RTX 3060 Ti. Free VRAM before setup was 6506 MiB. The runner now checks for at least 2048 MiB before each headed window. Every browser closes in `finally`.

Paced tests deliver identical chunks, in identical order, to every terminal. Counterbalanced repetitions alternate forward and reverse entry order. CPU counters cover the browser process family, including renderer and GPU processes. One CPU core is 100%. The six L6 workloads are retained without editing. The extra generated fixtures exercise a partial scroll region and insert/delete lines. Each timing result retains delivered byte counts, acknowledgement samples, frame intervals, output text, and before/after renderer metadata. `studyInfo()` and screenshot capture run outside the measured CPU window.

Acknowledgement and GPU completion have separate meanings. Our `write()` changes the core synchronously. Wraith's write promise acknowledges worker parsing. In the initial scheduled diagnostics, Wraith's public `flush()` forces a draw and awaits its engine fence. Our endpoint waits for the scheduled frame to submit, then awaits `GPUQueue.onSubmittedWorkDone()`. The latter includes frame scheduling. Neither endpoint is physical display latency, and requestAnimationFrame intervals are not displayed frame counts. Wraith's render-event counter and our submitted-frame metrics are retained separately.

Unicode text equality alone cannot qualify visible work. The Latin font lacks CJK and emoji coverage. Wraith needs explicit fallback font files, while browser rasterizers can choose system fallbacks. Unicode timings remain diagnostic unless those painted outputs qualify. Heatmap crops compare actual backing geometry and nonblack coverage, with exact pixel hashes retained where raster output is comparable.

## NimbleMarkets decision

M4 stops at geometry qualification. The corrected adapter passes the full ASCII, SGR, CJK, combining, cursor and ZWJ text smoke. The actual renderer is WebGPU on NVIDIA Ampere with `fallback: false`. Its font metrics are 8 by 14 physical pixels, with baseline 10, and an 800 by 420 backing. The other four entries have 7 by 19 cells and 700 by 570 backings. NimbleMarkets rounds the measured advance upward and uses the ink height of `M` plus padding. Its public terminal options expose neither line height nor letter spacing. CSS scaling would change the rendered work and would not qualify this cohort. No NimbleMarkets speed is reported.

The build and adapter attempt took about 39 minutes of wall time, mostly waiting for the shared runner. `qualified-smoke/results.json` retains the initial adapter failure. Its use of `BufferLine.translateToString()` dropped grapheme tails. Reading the same native core through `legacyText()` fixed the extractor. `nm-corrected-smoke/results.json` retains the successful text/backend check and the geometry mismatch. The smoke runner's `qualified` status means text qualification, not admission to the matched geometry cohort.

## Evidence and reproduction

Raw results and ownership receipts are in `/work/reports/ghostty-webgpu-next-2026-10/p0b/`. The packet retains exact browser bundles, source and asset hashes, workload metadata, screenshots, gate logs, and host observations.

Build with `WRAITH_SOURCE=/path/to/wraithterm NM_SOURCE=/path/to/nm-webgpu node scripts/build-study-comparison.mjs /path/to/bundle`. The sources must be at the revisions above. Build NimbleMarkets' core first with the packet's `tools/nm-build.sh`. Generate the extra fixtures with `python3 scripts/study-regions.py /path/to/workloads`, alongside the six retained L6 binaries and metadata. Run `scripts/study-run.mjs BUNDLE OUTPUT smoke` before measurements. The packet's `tools/run-pc.sh` and `tools/mac-run.sh` record the exact environment for this run. `scripts/study-pixels.mjs OUTPUT` regenerates the heatmap crop checks.

## Validation and retained work

Passed `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:unit`, and `bun run --cwd site docs:check`. Unit coverage is 1106 passed and one skipped. Benchmark-runner checks also pass. `bun run test:browser bench/comparison-legacy-text.browser.test.ts` passes both browser tests. The complete hardware smoke and paced matrix are the integration checks for the adapters.

The temporary NimbleMarkets and upstream Ghostty worktrees, plus the 428 MiB Zig download/compiler scratch, were removed after their consumers stopped. The lane checkout and Mac staging remain while the separately requested forced-completion follow-up runs. The raw packet is retained by the study coordinator for review and archival; final cleanup will be checked in the follow-up. No server, route, service, container or image was created.
