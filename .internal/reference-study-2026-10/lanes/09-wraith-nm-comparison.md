# M3 and M4 comparison

Status: measurements complete with the qualification limits below; PR review pending. M4 stops at geometry rejection. Experimental results, 2026-10-27.

## Verdict

Wraith's native worker pipeline has a conditional, workload-specific delivery advantage, with higher total CPU cost. For 16 terminals running OpenTUI plasma, the same 64 updates finish in 1097 ms versus our WebGPU's 1527 ms on PC, and 1347 ms versus 2275 ms on M1. That is 1.39x and 1.69x faster delivery. Total browser CPU time rises from 2.345 to 3.135 seconds on PC and from 2.555 to 3.649 seconds on M1, increases of 34% and 43%. This is an experimental delivery result, not physical display latency or a pixel-identical renderer speedup. The plasma painting differences below limit that claim.

It is not a general dense-path win. For 16-terminal NTCharts heatmap, delivery times are similar and Wraith uses 55% more CPU time on PC and 65% more on M1. The apparent one-terminal logging benefit in raw CPU percentages disappears when normalized to the same delivered work. Longer measurement windows can make a CPU-rate percentage look better without reducing total CPU time.

The plasma advantage is already visible at parse acknowledgement. In the PC forward arm, p50 acknowledgement for 16 terminals is 14.1 ms for ours and 2.4 ms for Wraith. GPU record size and font rasterization cannot explain a gain that occurs before rendering. Wraith has 16 dedicated workers and devices; our entry shares one main-thread runtime and device. The cohort compares whole pipelines and does not isolate harfrust/swash or the compact 20-byte record.

- **X5/E7:** give compact records lower priority than the worker-topology experiment, while retaining its bounded prototype and 20% dense-CPU reduction gate. The pixel-comparable heatmap has no demonstrated CPU win. Plasma has both ownership and painting confounds. Match parser/worker ownership before crediting the record layout; do not adopt compact records on this evidence.
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

All matched entries have 700 by 570 physical backings, with 7 by 19 cells. The viewport is 3360 by 2560 CSS pixels, fitting all 16 sections without rescaling. On PC, the heatmap has 399000 painted pixels in every crop. Our WebGPU, our WebGL2 and xterm decoded crops are identical. Wraith differs at 13 pixels, with a maximum two-level color difference. Plasma is not pixel-identical at half-block edges: Wraith's procedural blocks and our browser-rasterized blocks differ there. On PC, all 6000 upper/lower half-cell interior color samples match exactly. On Mac, only 3200 of 6000 match exactly, with a maximum 20-level channel difference. The Mac plasma comparison therefore has an additional rasterization confound. Mac heatmap differs at 14 of 399000 pixels, by at most two levels. Full-resolution crops were inspected. These limits are part of the experimental cadence result.

Native submitted-frame counters and Wraith render-event counters are retained before/after every workload. In 16-terminal plasma, native records 64 submissions per terminal. Wraith's observed deltas are 64..65; they include the forced text-qualification draw outside timing, so approximately 63..64 are workload draws. Equal final output and delivered bytes do not prove every intermediate presented image. The counters rule out a large reduction in rendered work as the explanation for the plasma delivery gap.

## Forced GPU completion

The matched probe forces each native renderer's existing scheduler to draw, then awaits its actual `GPUQueue.onSubmittedWorkDone()`. Wraith uses its public `flush()`, which forces a draw and awaits its engine fence. All 32 input updates per terminal are acknowledged before each endpoint waits for drawing. The table shows median parse/API acknowledgement time, then write-start-to-GPU-completion p50 and p95, in milliseconds. These are browser/driver readiness endpoints, not timestamp-query GPU duration or physical display latency.

The native force hook runs per renderer outside the normal shared RAF coordinator's batching. It can issue separate submissions for each renderer. Use the paced table to assess normal production CPU cost; these forced endpoints do not isolate GPU algorithms or record size. Private access is confined to the benchmark and checked against the actual scheduler/device classes.

| Host / terminals | Workload            | acknowledgement ours / Wraith | completion p50 ours / Wraith | completion p95 ours / Wraith |
| ---------------- | ------------------- | ----------------------------: | ---------------------------: | ---------------------------: |
| PC / 1           | ntcharts-heatmap    |                   0.40 / 0.50 |                  3.55 / 3.70 |                  4.00 / 4.10 |
| PC / 1           | opentui-plasma      |                   0.85 / 0.90 |                  4.23 / 3.90 |                  5.00 / 4.45 |
| PC / 1           | partial-scroll      |                   0.05 / 0.15 |                  3.22 / 3.70 |                  3.50 / 4.30 |
| PC / 1           | insert-delete-lines |                   0.10 / 0.15 |                  3.18 / 3.65 |                  3.80 / 3.95 |
| PC / 16          | ntcharts-heatmap    |                   5.10 / 1.10 |                17.20 / 13.40 |                19.45 / 26.80 |
| PC / 16          | opentui-plasma      |                  13.27 / 2.35 |                27.65 / 16.15 |                38.80 / 39.50 |
| PC / 16          | partial-scroll      |                   0.10 / 0.30 |                10.90 / 16.65 |                15.00 / 19.40 |
| PC / 16          | insert-delete-lines |                   0.20 / 0.40 |                11.00 / 19.80 |                12.85 / 28.20 |
| MAC / 1          | ntcharts-heatmap    |                   1.35 / 1.70 |                  4.17 / 3.80 |                  5.00 / 5.95 |
| MAC / 1          | opentui-plasma      |                   2.10 / 2.85 |                  4.92 / 5.25 |                  6.65 / 7.00 |
| MAC / 1          | partial-scroll      |                   0.10 / 0.40 |                  2.38 / 2.72 |                  3.35 / 4.10 |
| MAC / 1          | insert-delete-lines |                   0.10 / 0.38 |                  1.70 / 2.78 |                  2.90 / 4.25 |
| MAC / 16         | ntcharts-heatmap    |                   8.50 / 2.72 |                18.75 / 10.00 |                19.15 / 14.15 |
| MAC / 16         | opentui-plasma      |                  16.40 / 5.17 |                30.58 / 15.85 |                33.05 / 28.25 |
| MAC / 16         | partial-scroll      |                   0.10 / 0.80 |                 6.50 / 10.22 |                 7.95 / 14.90 |
| MAC / 16         | insert-delete-lines |                   0.20 / 0.83 |                 6.55 / 10.60 |                 7.40 / 13.80 |

All eight fixtures ran; representative endpoints are shown here and the full arrays remain in the packet. Each cell uses two counterbalanced windows except **PC Wraith with 16 terminals, n=1**. Its forward arm was rejected on the first heatmap window at 92% GPU utilization against the existing 80% guard. No new compute PID appeared and resident compute memory changed from 719 to 722 MiB; the cause of the utilization spike is not isolated. The reverse arm passed all fixtures. The failed arm and sampler evidence are retained, not replaced. The Mac forced cohort passed all eight arms.

One-terminal forced completion is broadly comparable. At 16 terminals, dense acknowledgement/completion favors Wraith, while partial scrolling and insert/delete-line completion favor ours. The dense acknowledgement advantage exists before frame construction, reinforcing the worker-ownership explanation. These observations do not establish a compact-record or in-wasm font CPU win.

The earlier `pc-fenced*` and `mac-fenced*` files are retained as **scheduled-presentation diagnostics**. They wait for our next scheduled frame while forcing Wraith's draw. Their large readiness gap includes that policy difference and is not a matched GPU-execution result. One initial PC scheduled 16-terminal arm also hit the utilization guard. Those cases are separate from the matched `*-forced-completion` datasets.

## Scope and method

This follows M3 and M4 in `next-steps.md` from `origin/plan/renderer-next-2026-10`. Runtime source starts at ghostty-webgpu `d2ed8989a745f016188e0a2e749009b3e1450f33`. No product renderer changes are included.

Wraith is `betterclever/wraithterm@115106931ce4934db6bc41f4d7939eb80551d248`, through native `Wraith.mount`, with one dedicated worker per terminal. Its xterm wrapper is excluded from the bundled entry. The prebuilt engine is the revision's checked-in artifact. NimbleMarkets is `nm-webgpu@bfbe0e5c82b12d1f7cfde9784877fbf3a2c9ddc9`, with its own patch applied to Ghostty `6590196661f769dd8f2b3e85d6c98262c4ec5b3b` and compiled by Zig 0.15.2. The resulting 625239-byte core has SHA-256 `53e131008bde7744b9244768918f0f22966eaf35f0c2ef53e5209059bab49f27`, exactly matching lane 07b's successful build. Xterm is `@xterm/xterm@6.0.0` with `@xterm/addon-webgl@0.19.0`.

The grid is 100 columns by 30 rows, DPR 1, with the same JetBrains Mono font file. Wraith receives the lossless SFNT conversion of the browser's WOFF2. Its public line-height option targets our fitted physical cell height. All entries request 10000 lines of history. Our core also has its normal 64 MiB byte budget. Wraith's dedicated-worker and device ownership differs from our shared main-thread runtime and device. These are end-to-end entry comparisons, not an isolated test of record size or font rasterization.

The retained native-only smoke ran first, in headed Chromium 153.0.8010.12, on NVIDIA RTX 3060 Ti with driver 615.78.08. It passed text qualification and reported NVIDIA Ampere with `fallback: false`. The browser's ANGLE renderer also names the RTX 3060 Ti. Free VRAM before setup was 6506 MiB. The runner now checks for at least 2048 MiB before each headed window. Every browser closes in `finally`.

Paced tests deliver identical chunks, in identical order, to every terminal. Counterbalanced repetitions alternate forward and reverse entry order. CPU counters cover the browser process family, including renderer and GPU processes. One CPU core is 100%. The six L6 workloads are retained without editing. The extra generated fixtures exercise a partial scroll region and insert/delete lines. Each timing result retains delivered byte counts, acknowledgement samples, frame intervals, output text, and before/after renderer metadata. `studyInfo()` and screenshot capture run outside the measured CPU window.

Acknowledgement and GPU completion have separate meanings. Our `write()` changes the core synchronously. Wraith's write promise acknowledges worker parsing. In the matched forced cohort, both endpoints force drawing before waiting for their GPU queue. The retained initial scheduled diagnostics additionally include our frame scheduling delay and are labeled separately. Neither endpoint is physical display latency, and requestAnimationFrame intervals are not displayed frame counts. Wraith's render-event counter and our submitted-frame metrics are retained separately.

Unicode text equality alone cannot qualify visible work. The Latin font lacks CJK and emoji coverage. Wraith needs explicit fallback font files, while browser rasterizers can choose system fallbacks. Unicode timings remain diagnostic unless those painted outputs qualify. Heatmap crops compare actual backing geometry and nonblack coverage, with exact pixel hashes retained where raster output is comparable.

## NimbleMarkets decision

M4 stops at geometry qualification. The corrected adapter passes the full ASCII, SGR, CJK, combining, cursor and ZWJ text smoke. The actual renderer is WebGPU on NVIDIA Ampere with `fallback: false`. Its font metrics are 8 by 14 physical pixels, with baseline 10, and an 800 by 420 backing. The other four entries have 7 by 19 cells and 700 by 570 backings. NimbleMarkets rounds the measured advance upward and uses the ink height of `M` plus padding. Its public terminal options expose neither line height nor letter spacing. CSS scaling would change the rendered work and would not qualify this cohort. No NimbleMarkets speed is reported.

The build and adapter attempt took about 39 minutes of wall time, mostly waiting for the shared runner. `qualified-smoke/results.json` retains the initial adapter failure. Its use of `BufferLine.translateToString()` dropped grapheme tails. Reading the same native core through `legacyText()` fixed the extractor. `nm-corrected-smoke/results.json` retains the successful text/backend check and the geometry mismatch. The smoke runner's `qualified` status means text qualification, not admission to the matched geometry cohort.

## Evidence and reproduction

Raw results and ownership receipts are in `/work/reports/ghostty-webgpu-next-2026-10/p0b/`. The packet retains exact browser bundles, source and asset hashes, workload metadata, screenshots, gate logs, and host observations.

Build with `WRAITH_SOURCE=/path/to/wraithterm NM_SOURCE=/path/to/nm-webgpu node scripts/build-study-comparison.mjs /path/to/bundle`. The sources must be at the revisions above. Build NimbleMarkets' core first with the packet's `tools/nm-build.sh`. Generate the extra fixtures with `python3 scripts/study-regions.py /path/to/workloads`, alongside the six retained L6 binaries and metadata. Run `scripts/study-run.mjs BUNDLE OUTPUT smoke` before measurements. The packet's `tools/run-pc.sh` and `tools/mac-run.sh` record the exact environment for this run. `scripts/study-pixels.mjs OUTPUT` regenerates the heatmap crop checks.

## Validation and retained work

Passed `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:unit`, and `bun run --cwd site docs:check`. Unit coverage is 1106 passed and one skipped. Benchmark-runner checks also pass. `bun run test:browser bench/comparison-legacy-text.browser.test.ts` passes both browser tests. The complete hardware smoke and paced matrix are the integration checks for the adapters.

The temporary NimbleMarkets and upstream Ghostty worktrees, plus the 428 MiB Zig download/compiler scratch, were removed after their consumers stopped. The Mac staging and task-created browser profiles have been removed after SHA-256 verification of all seven result directories. The lane checkout and its installed/build payloads are removed after the follow-up push. The raw packet is retained by the study coordinator for review and archival; removal condition is completion or archival of this wave. No server, route, service, container or image was created.

The main paced bundle is immutable. The PC forced bundle has a fresh manifest and source/asset hashes. The Mac forced bundle was compiled from the retained source snapshot using the exact installed hotkeys/store packages; `mac-forced-bundle/mac-forced-provenance.json` identifies the actual browser/worker/wasm hashes and source archive. Its inherited manifest supplies baseline native assets and settings only, not the rebuilt browser hash. Worker-only adapter probes record NVIDIA Ampere on PC and Apple Metal 3 on Mac, both with `fallback: false`.

The checked remote cleanup receipt is `cleanup-mac.json`: all seven result-directory hashes matched their collected copies, 73,308,144 bytes of staging were removed, and the interrupted 11,072,488-byte browser profile was removed. Other agents' locks and the pre-existing Playwright/package caches were preserved. Local compiler/reference cleanup and removed transient profiles are recorded in `cleanup-local*.json`. The retained packet is approximately 129 MiB, owned by the coordinator until this wave is reviewed and archived.
