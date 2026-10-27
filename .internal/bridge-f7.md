# F7 upload gap thresholds

Status: Approved. Implementation commit: `a7fcc46ea5773cdf52c3e1b34b4c1c30ae39c233`. Baseline: `d2ed8989a`.

The ordinary edit planner sorts owned nonempty ranges, merges overlapping/touching/nearby edits, and splits larger clean gaps. WebGPU merges gaps up to 4096 bytes; WebGL2 merges gaps up to 16384 bytes. Cell and glyph ranges are independent. Input arrays and ranges remain borrowed and unchanged. The exact sparse row-remap planner and two-sided wrapped planner retain their existing behavior. WebGPU scrolling continues to use those plans. WebGL2 ordinary redraws, including scroll redraws, now use its measured gap threshold.

## Prospective calibration

The thresholds were selected after running `bun scripts/upload-gap-benchmark.ts` on both hosts, before implementing the new planner. The sweep compares one bounding upload against two 64-byte uploads, with clean gaps of 0, 256, 1024, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576 and 1599872 bytes. Each point runs 300 updates and five counterbalanced repetitions. One update makes one `writeBuffer` or `bufferSubData` call and sends `128+gap` bytes in the bounded arm, versus two calls and 128 bytes in the split arm. Every sample records calls, bytes, synchronous call time, completion time and browser-process CPU.

Host/browser: headed Chromium 153.0.8010.12, RTX 3060 Ti through NVIDIA ANGLE on Linux 7.2.11-arch1-1, and Apple M1 through Metal on macOS 26.4. Both WebGPU adapters report fallback=false; WebGL2 reports the hardware ANGLE renderer. The Mac was on AC under the shared lock. These are experimental measurements.

The browser clock resolves 0.1 ms, while process CPU counters resolve about 10 ms. At tiny gaps the 300-update batch approaches those limits. The observed crossover brackets are PC WebGPU 1–4 KiB, Mac WebGPU 256 B–1 KiB, PC WebGL2 4–8 KiB and Mac WebGL2 8–16 KiB. The selected inclusive thresholds use the conservative upper end across hosts, avoiding extra calls near timer noise. This is not a device-specific autotuner. Actual glyph records are 96 bytes rather than the calibration's 64 bytes; the terminal pair below checks the resulting real upload path.

The table uses median batch call time in milliseconds, with the summed process CPU milliseconds across five repetitions. CPU includes the measurement round trips and is too coarse to rank the smallest gaps; it corroborates the large-gap cost. Full per-repetition bytes/calls and completion times remain in `pc-gaps.json` and `mac-gaps.json` under `/work/reports/ghostty-webgpu-next-2026-10/bridge/f7/`.

| Host | Backend | Gap bytes | Bound → split call time, ms/300 updates | Bound → split CPU, ms/1500 updates |
| ---- | ------- | --------- | --------------------------------------- | ---------------------------------- |
| PC   | webgpu  | 0         | 0.00 → 0.10                             | 10 → 0                             |
| PC   | webgpu  | 256       | 0.10 → 0.10                             | 20 → 20                            |
| PC   | webgpu  | 1024      | 0.10 → 0.10                             | 10 → 10                            |
| PC   | webgpu  | 4096      | 0.30 → 0.00                             | 10 → 0                             |
| PC   | webgpu  | 8192      | 0.50 → 0.10                             | 30 → 0                             |
| PC   | webgpu  | 16384     | 1.40 → 0.10                             | 10 → 0                             |
| PC   | webgpu  | 32768     | 2.10 → 0.10                             | 30 → 0                             |
| PC   | webgpu  | 65536     | 4.70 → 0.10                             | 110 → 10                           |
| PC   | webgpu  | 131072    | 11.80 → 0.10                            | 120 → 0                            |
| PC   | webgpu  | 262144    | 28.60 → 0.10                            | 290 → 0                            |
| PC   | webgpu  | 524288    | 71.30 → 0.10                            | 470 → 20                           |
| PC   | webgpu  | 1048576   | 182.30 → 0.10                           | 1130 → 20                          |
| PC   | webgpu  | 1599872   | 316.60 → 0.00                           | 1800 → 0                           |
| PC   | webgl2  | 0         | 0.10 → 0.10                             | 10 → 30                            |
| PC   | webgl2  | 256       | 0.00 → 0.10                             | 0 → 0                              |
| PC   | webgl2  | 1024      | 0.10 → 0.10                             | 10 → 0                             |
| PC   | webgl2  | 4096      | 0.10 → 0.00                             | 0 → 20                             |
| PC   | webgl2  | 8192      | 0.20 → 0.10                             | 0 → 0                              |
| PC   | webgl2  | 16384     | 0.30 → 0.20                             | 10 → 20                            |
| PC   | webgl2  | 32768     | 0.60 → 0.10                             | 0 → 10                             |
| PC   | webgl2  | 65536     | 4.20 → 0.10                             | 30 → 20                            |
| PC   | webgl2  | 131072    | 7.40 → 0.10                             | 60 → 10                            |
| PC   | webgl2  | 262144    | 15.20 → 0.10                            | 130 → 10                           |
| PC   | webgl2  | 524288    | 33.20 → 0.20                            | 260 → 10                           |
| PC   | webgl2  | 1048576   | 75.90 → 0.20                            | 530 → 10                           |
| PC   | webgl2  | 1599872   | 183.80 → 0.10                           | 870 → 0                            |
| Mac  | webgpu  | 0         | 0.10 → 0.10                             | 5 → 5                              |
| Mac  | webgpu  | 256       | 0.10 → 0.10                             | 4 → 4                              |
| Mac  | webgpu  | 1024      | 0.20 → 0.10                             | 5 → 5                              |
| Mac  | webgpu  | 4096      | 0.50 → 0.10                             | 10 → 5                             |
| Mac  | webgpu  | 8192      | 1.10 → 0.10                             | 13 → 6                             |
| Mac  | webgpu  | 16384     | 2.10 → 0.10                             | 24 → 6                             |
| Mac  | webgpu  | 32768     | 4.10 → 0.10                             | 40 → 7                             |
| Mac  | webgpu  | 65536     | 8.20 → 0.10                             | 57 → 6                             |
| Mac  | webgpu  | 131072    | 16.30 → 0.10                            | 114 → 17                           |
| Mac  | webgpu  | 262144    | 31.20 → 0.10                            | 207 → 10                           |
| Mac  | webgpu  | 524288    | 70.40 → 0.10                            | 453 → 8                            |
| Mac  | webgpu  | 1048576   | 143.40 → 0.10                           | 780 → 5                            |
| Mac  | webgpu  | 1599872   | 247.00 → 0.10                           | 1348 → 30                          |
| Mac  | webgl2  | 0         | 0.10 → 0.10                             | 4 → 3                              |
| Mac  | webgl2  | 256       | 0.10 → 0.10                             | 2 → 3                              |
| Mac  | webgl2  | 1024      | 0.10 → 0.10                             | 3 → 3                              |
| Mac  | webgl2  | 4096      | 0.10 → 0.10                             | 4 → 4                              |
| Mac  | webgl2  | 8192      | 0.10 → 0.10                             | 4 → 3                              |
| Mac  | webgl2  | 16384     | 0.20 → 0.10                             | 3 → 3                              |
| Mac  | webgl2  | 32768     | 0.30 → 0.10                             | 5 → 3                              |
| Mac  | webgl2  | 65536     | 1.00 → 0.10                             | 11 → 3                             |
| Mac  | webgl2  | 131072    | 2.30 → 0.10                             | 18 → 3                             |
| Mac  | webgl2  | 262144    | 3.60 → 0.10                             | 28 → 4                             |
| Mac  | webgl2  | 524288    | 8.50 → 0.10                             | 64 → 3                             |
| Mac  | webgl2  | 1048576   | 19.50 → 0.10                            | 113 → 3                            |
| Mac  | webgl2  | 1599872   | 31.90 → 0.10                            | 170 → 3                            |

## Complete-terminal before/after

`bun run bench:renderer` uses the same-session AB/BA/AB protocol, 80 measured updates after 10 warmups at 200×50. The sparse-edit fixture changes two distant cells and retains wide, combining, italic overhang and color glyphs on an untouched row. All 36 pairs have exact decoded-pixel, final-text, input-byte, built-frame and submitted-frame equality. Scrolling and burst output remain in the cohort to measure the increased call count against saved bytes.

| Host | Backend | Workload         | Uploaded bytes/update before → after | Upload calls/update before → after | Browser CPU before → after, % |
| ---- | ------- | ---------------- | ------------------------------------ | ---------------------------------- | ----------------------------- |
| PC   | webgl2  | sparse-edit      | 959904.0 → 192.0                     | 1 → 2                              | 11.1 → 6.7                    |
| PC   | webgl2  | burst-output     | 921706.8 → 5233.2                    | 1 → 49                             | 13.3 → 10.4                   |
| PC   | webgl2  | sustained-scroll | 953769.6 → 19488.0                   | 2 → 51                             | 12.6 → 8.9                    |
| PC   | webgpu  | sparse-edit      | 959904.0 → 192.0                     | 1 → 2                              | 14.6 → 13.9                   |
| PC   | webgpu  | burst-output     | 39518.0 → 39518.0                    | 13 → 13                            | 16.2 → 16.3                   |
| PC   | webgpu  | sustained-scroll | 120.0 → 120.0                        | 1 → 1                              | 16.3 → 16.2                   |
| Mac  | webgl2  | sparse-edit      | 959904.0 → 192.0                     | 1 → 2                              | 29.9 → 26.5                   |
| Mac  | webgl2  | burst-output     | 921706.8 → 5233.2                    | 1 → 49                             | 33.2 → 33.9                   |
| Mac  | webgl2  | sustained-scroll | 953769.6 → 19488.0                   | 2 → 51                             | 33.0 → 33.0                   |
| Mac  | webgpu  | sparse-edit      | 959904.0 → 192.0                     | 1 → 2                              | 34.0 → 34.6                   |
| Mac  | webgpu  | burst-output     | 39518.0 → 39518.0                    | 13 → 13                            | 37.4 → 36.0                   |
| Mac  | webgpu  | sustained-scroll | 120.0 → 120.0                        | 1 → 1                              | 33.1 → 34.6                   |

For the distant edits only glyph records change, so bytes fall from 959904 to 192 and calls rise from one to two. Unit tests separately pin both cell and glyph thresholds, independent gaps, exact threshold boundaries, unordered input, overlapping/contained/duplicate intervals, glyph erasure and borrowed-input preservation. Existing wrap and remap tests pass unchanged. WebGPU scroll remains 120 bytes and one upload per update. WebGL2 scroll trades two large uploads for 51 small uploads; CPU improves on PC and is flat on Mac in this session. A general Mac CPU improvement is not claimed.

The runtime source matches the implementation commit named above. Hardware pairs preceded that commit; their recorded worktree HEAD is the baseline on PC and empty in the copied Mac sources. Saved bundle hashes identify each measured candidate. This change does not alter either Wasm artifact. Raw calibration, renderer JSON, bundles, screenshots, parity results and command logs are retained in the report directory.

## Verification and reproduction

The new range tests failed on the old bounding planner before implementation. `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check` pass. The unit gate passes 1109 Vitest tests, 482 Bun comparison tests and 4 checkpoint tests, with an existing skip. The browser gate passes 84 tests with 2 existing skips across WebGL frame/text-pass and WebGPU renderer suites.

Run the prospective sweep with `BENCH_OUTPUT=<gaps.json> bun scripts/upload-gap-benchmark.ts`. Run the complete terminal pair with `BENCH_BACKENDS=webgl2,webgpu BENCH_SCENARIOS=sparse-edit,burst-output,sustained-scroll BENCH_STEPS=80 BENCH_WARMUP_STEPS=10 BENCH_REPETITIONS=3 BENCH_BASELINE_ROOT=<baseline-source> BENCH_OUTPUT=<report.json> bun run bench:renderer`. Reserve a quiet hardware session first, check PC free VRAM before opening Chromium, and close each cohort's browser before the next.
