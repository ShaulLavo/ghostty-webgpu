# Terminal comparison benchmarks

These are instrumented whole-terminal measurements of ghostty-webgpu 0.3.21 (Fregat commit `fb67ac08ded224fd6579389a23796e015ee23d5c`). They measure CPU work and estimated CPU energy while terminals receive paced output, and they show workload-specific results from one Mac on the evening of 2026-10-09 UTC. Later builds are not measured here.

Every ratio is ghostty divided by xterm.js. Below 1 means ghostty uses less. Energy and instructions are the efficiency metrics. CPU seconds appear for context. Apple Silicon changes its clock speed with load, so a run that does less work can take more CPU seconds.

[Scores](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/scores.json) · [Method and recompute](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/README.md) · [Offline verifier](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/verify.mjs)

## WebGL vs xterm.js WebGL

Apple M1 MacBook, AC power, headed Chrome 154.0.8037.93, hardware ANGLE Metal GPU. Acquired 2026-10-09 UTC, reviewed 2026-10-10. ghostty-webgpu 0.3.21; xterm.js 6.0.0 with WebGL addon 0.19.0, plus its Unicode 11 addon 0.9.0 on one Unicode line per tick. 40 × 12 cells, DPR 2, a 560 × 456-pixel drawing buffer for both libraries, 17 visible terminals. Each workload has 120 warm-up ticks and 900 measured ticks paced at 60 Hz. Each row is the median of two balanced pair ratios from one browser session, and every workload ran in its own session. Counters cover the endpoint-enumerated Chrome process family, including GPU-process CPU work.

| Workload                  | History          | CPU energy ratio | Instruction ratio | CPU seconds ratio | Pairs                                            | Evidence                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------------- | ---------------: | ----------------: | ----------------: | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Heavy log output          | 8,841 final rows |            0.612 |             0.613 |             0.759 | Lower in both pairs                              | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-rolling-logs.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)         |
| Heavy Unicode output      | 9,572 final rows |            0.611 |             0.615 |             0.761 | Lower in both pairs                              | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-rolling-unicode-logs.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json) |
| One Unicode line per tick | 889 rows         |            0.986 |             1.002 |             0.989 | Energy lower, instructions higher, in both pairs | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-unicode-emoji.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)        |
| One ASCII line per tick   | 889 rows         |            0.955 |             0.985 |             0.991 | Lower in both pairs                              | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-line-scroll.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)          |
| Typing-like edits         | 0 rows           |            0.911 |             0.954 |             1.011 | Lower in both pairs                              | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-interactive-edits.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)    |

WebGL uses 39% less estimated CPU energy and 39% fewer instructions on heavy log output. The same two figures are 39% and 39% on heavy Unicode output, 5% and 1% on one ASCII line per tick and 9% and 5% on typing-like edits. One ASCII line per tick is the `line-scroll` workload: each tick appends one line, so the screen scrolls one row per tick. Its margins and the edits margins are small and come from two pairs per cell.

One Unicode line per tick is even. Energy is 1.4% lower in both pairs and instructions are 0.2% higher in both pairs.

The bounded log workloads finish with matching retained text and equal history: 8,841 rows per terminal for heavy log output and 9,572 for heavy Unicode output. The check compares final retained output. It does not prove equal intermediate retention or identical rasters.

## DOM vs xterm.js DOM

Same machine, browser, build and dates. ghostty-webgpu 0.3.21 DOM against xterm.js 6.0.0 DOM. Both use a normalized 360 × 288 CSS-pixel surface, a 15px font and hidden scrollbars. 40 × 12 cells, DPR 2, 17 visible terminals, 120 warm-up ticks and 900 measured ticks at 60 Hz. Ratios are medians of two balanced pairs of all-Chrome counter deltas.

| Workload                | History          | CPU energy ratio | Instruction ratio | CPU seconds ratio | Pairs                      | Evidence                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------- | ---------------: | ----------------: | ----------------: | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heavy log output        | 8,841 final rows |            0.529 |             0.592 |             0.702 | Lower in both pairs        | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/dom-rolling-logs.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)         |
| Heavy Unicode output    | 9,572 final rows |            0.592 |             0.618 |             0.704 | Lower in both pairs        | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/dom-rolling-unicode-logs.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json) |
| One ASCII line per tick | 889 rows         |            0.669 |             0.799 |             0.976 | Lower in both pairs        | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/dom-line-scroll.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)          |
| Typing-like edits       | 0 rows           |            1.008 |             0.998 |             1.022 | Mixed across the two pairs | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/dom-interactive-edits.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)    |

DOM uses 47% less estimated CPU energy and 41% fewer instructions on heavy log output. The same two figures are 41% and 38% on heavy Unicode output and 33% and 20% on one ASCII line per tick. Typing-like edits are even: median energy is 0.8% higher, median instructions are 0.2% lower, and the two pairs disagree on both energy and instructions.

One Unicode line per tick is unavailable for DOM: xterm.js DOM settled to two different images within the same actor in both attempts, so the equal-output check failed. No qualified comparison exists.

## Not published here

This page publishes the WebGL and DOM tables only. Canvas, WebGPU, Linux and Raspberry Pi 4 results are not published. xterm.js has no WebGPU renderer, so a WebGPU row would be a cross-API comparison.

## Memory

A fair memory comparison covers the whole browser process family, including resident WebAssembly memory. Report the idle baseline, retained-history phase and their delta, along with actual retained rows. GPU-device allocations need a separate measurement and label. Avoid adding WASM capacity to RSS, which already includes resident WASM pages.

This page makes no numeric memory claim.

## Method limits

Energy is the macOS kernel's per-process CPU energy estimate from `proc_pid_rusage` with `RUSAGE_INFO_V6`. It includes GPU-process CPU work, and excludes GPU-device, display, non-Chrome and whole-system power. Instructions are retired CPU instructions across the same process family. Cycles, CPU seconds, core placement and effective clocks are diagnostics. The M1 runs light work on its efficiency cores, so a terminal that does less work can show more cycles.

Each cell has two chronological ghostty and xterm.js pairs, ordered ABBA or BAAB. A browser session shares windows between renderers, so the two windows of a pair need not be adjacent. Two pairs give descriptive observations. They carry no significance test. The benchmark observer is enabled and its overhead is not calibrated, so none is subtracted.

Native snapshots bracket the reset, paced writes, logical settlement through two animation frames, and target-counter snapshots. Text and screenshots are captured afterwards. This endpoint proves logical settlement; it does not prove physical presentation. Stable PID, type and start identities at the endpoints cannot capture a process born and gone entirely between samples. Samples are sequential and non-atomic.

These tables do not support a claim that ghostty is faster on every workload. Each saved record preserves per-process counter deltas, output digests and work counts. Recompute every ratio with `node docs/benchmarks/mac-m1-2026-10-10/verify.mjs`, from `ghostty-webgpu/`.
