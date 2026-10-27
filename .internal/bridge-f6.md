# F6 row identity index

Status: Approved. Implementation commit: `9da1e9063152ebbf34aaa8a7bad105c289e22576`.

The cache indexes both opaque row-id words in a half-full, preallocated hash table. Insertion keeps the first source for duplicate IDs, and lookup does not consume a match. Unmatched destinations take unused sources with one forward-only cursor. This replaces both repeated scans. Rotation, streaming, and row reuse checks stay unchanged. Expected matching and unused-slot assignment cost is O(R), with O(R) scratch space, rather than O(R²). Existing O(N) record copies are unchanged. The 500-row table adds 24 KiB per frame builder.

Two direct Zig tests pin duplicate, both-word, collision, missing-id and reset behavior. All 107 existing frame-builder tests pass, including scroll direction, row movement, missing-glyph retries, wide/combining/color glyphs, and exact record reuse. The normal gates pass with 1106 unit tests, 482 Bun comparison tests, 4 checkpoint tests and 77 browser tests, with existing skips.

## Measurements

Raw evidence: `/work/reports/ghostty-webgpu-next-2026-10/bridge/f6/`. Three same-session AB/BA/AB repetitions per workload and backend, 40 measured updates after 10 warmups, headed Playwright Chromium 153.0.8010.12. PC uses RTX 3060 Ti through NVIDIA ANGLE, Linux 7.2.11-arch1-1; Mac uses Apple M1 through Metal, macOS 26.4. The JSON records browser, OS, adapter, bundle hashes and artifact hashes. Baseline is `d2ed8989a`, candidate runtime is the implementation commit above. Early runs were made before that commit; their recorded HEAD is the baseline, with candidate bundle and bridge hashes identifying the changed source. Mac runs use copied source rather than a Git checkout, so their Git revision fields are empty. Both copies came from these exact worktrees. These timings are experimental.

`rowPlanMilliseconds` brackets the build entry through its second row-iterator reset, before cell decoding. It includes cache setup, matching, rotation planning and required record copies. The two getter hooks add the same timing overhead to both arms. This is not CPU-only instruction profiling. `bridgeMilliseconds` measures the whole frame build. Values below are medians of per-repetition totals divided by build count, in microseconds per build.

The 500-row case uses font size 8 and DPR 1 to keep its canvas below the default WebGPU 8192-pixel limit. The first two PC attempts at font size 13 failed the visible-ink check and are excluded. Constant-cell-count cases use font size 8 and DPR 1 on both hosts. The first PC 200×50 and 300×80 runs use font size 13 and DPR 2; all Mac cases use font size 8 and DPR 1. Compare arms within a host and geometry, not across those pixel geometries.

| Host | Grid    | Backend | Workload         | Row plan before → after, µs | Whole bridge before → after, µs |
| ---- | ------- | ------- | ---------------- | --------------------------- | ------------------------------- |
| PC   | 200x50  | webgl2  | dense-redraw     | 7.5 → 12.5                  | 150.0 → 135.0                   |
| PC   | 200x50  | webgl2  | sustained-scroll | 65.0 → 85.0                 | 227.5 → 232.5                   |
| PC   | 200x50  | webgpu  | dense-redraw     | 10.0 → 20.0                 | 125.0 → 135.0                   |
| PC   | 200x50  | webgpu  | sustained-scroll | 12.5 → 17.5                 | 62.5 → 65.0                     |
| PC   | 300x80  | webgl2  | dense-redraw     | 15.0 → 17.5                 | 297.5 → 292.5                   |
| PC   | 300x80  | webgl2  | sustained-scroll | 177.5 → 175.0               | 550.0 → 537.5                   |
| PC   | 300x80  | webgpu  | dense-redraw     | 20.0 → 17.5                 | 305.0 → 300.0                   |
| PC   | 300x80  | webgpu  | sustained-scroll | 27.5 → 20.0                 | 140.0 → 137.5                   |
| PC   | 120x500 | webgl2  | dense-redraw     | 102.5 → 42.5                | 880.0 → 760.0                   |
| PC   | 120x500 | webgl2  | sustained-scroll | 502.5 → 455.0               | 1452.5 → 1420.0                 |
| PC   | 120x500 | webgpu  | dense-redraw     | 92.5 → 47.5                 | 852.5 → 780.0                   |
| PC   | 120x500 | webgpu  | sustained-scroll | 115.0 → 50.0                | 425.0 → 352.5                   |
| PC   | 400x25  | webgl2  | dense-redraw     | 15.0 → 10.0                 | 152.5 → 150.0                   |
| PC   | 400x25  | webgl2  | sustained-scroll | 65.0 → 102.5                | 197.5 → 270.0                   |
| PC   | 400x25  | webgpu  | dense-redraw     | 12.5 → 10.0                 | 145.0 → 122.5                   |
| PC   | 400x25  | webgpu  | sustained-scroll | 10.0 → 12.5                 | 65.0 → 62.5                     |
| PC   | 100x100 | webgl2  | dense-redraw     | 15.0 → 17.5                 | 147.5 → 140.0                   |
| PC   | 100x100 | webgl2  | sustained-scroll | 97.5 → 62.5                 | 282.5 → 200.0                   |
| PC   | 100x100 | webgpu  | dense-redraw     | 27.5 → 22.5                 | 167.5 → 152.5                   |
| PC   | 100x100 | webgpu  | sustained-scroll | 25.0 → 20.0                 | 57.5 → 75.0                     |
| PC   | 40x250  | webgl2  | dense-redraw     | 50.0 → 40.0                 | 245.0 → 215.0                   |
| PC   | 40x250  | webgl2  | sustained-scroll | 137.5 → 105.0               | 317.5 → 297.5                   |
| PC   | 40x250  | webgpu  | dense-redraw     | 42.5 → 30.0                 | 220.0 → 237.5                   |
| PC   | 40x250  | webgpu  | sustained-scroll | 47.5 → 45.0                 | 92.5 → 95.0                     |
| Mac  | 200x50  | webgl2  | dense-redraw     | 40.0 → 25.0                 | 407.5 → 447.5                   |
| Mac  | 200x50  | webgl2  | sustained-scroll | 117.5 → 132.5               | 752.5 → 830.0                   |
| Mac  | 200x50  | webgpu  | dense-redraw     | 20.0 → 50.0                 | 337.5 → 510.0                   |
| Mac  | 200x50  | webgpu  | sustained-scroll | 57.5 → 65.0                 | 257.5 → 180.0                   |
| Mac  | 300x80  | webgl2  | dense-redraw     | 32.5 → 50.0                 | 832.5 → 1045.0                  |
| Mac  | 300x80  | webgl2  | sustained-scroll | 170.0 → 152.5               | 1542.5 → 1405.0                 |
| Mac  | 300x80  | webgpu  | dense-redraw     | 32.5 → 17.5                 | 792.5 → 570.0                   |
| Mac  | 300x80  | webgpu  | sustained-scroll | 92.5 → 65.0                 | 462.5 → 310.0                   |
| Mac  | 120x500 | webgl2  | dense-redraw     | 250.0 → 85.0                | 2072.5 → 1965.0                 |
| Mac  | 120x500 | webgl2  | sustained-scroll | 437.5 → 325.0               | 2752.5 → 2825.0                 |
| Mac  | 120x500 | webgpu  | dense-redraw     | 227.5 → 97.5                | 2055.0 → 1965.0                 |
| Mac  | 120x500 | webgpu  | sustained-scroll | 342.5 → 160.0               | 1010.0 → 897.5                  |
| Mac  | 400x25  | webgl2  | dense-redraw     | 45.0 → 37.5                 | 507.5 → 560.0                   |
| Mac  | 400x25  | webgl2  | sustained-scroll | 120.0 → 110.0               | 885.0 → 870.0                   |
| Mac  | 400x25  | webgpu  | dense-redraw     | 37.5 → 40.0                 | 505.0 → 507.5                   |
| Mac  | 400x25  | webgpu  | sustained-scroll | 70.0 → 77.5                 | 237.5 → 290.0                   |
| Mac  | 100x100 | webgl2  | dense-redraw     | 50.0 → 65.0                 | 522.5 → 630.0                   |
| Mac  | 100x100 | webgl2  | sustained-scroll | 160.0 → 147.5               | 912.5 → 872.5                   |
| Mac  | 100x100 | webgpu  | dense-redraw     | 47.5 → 50.0                 | 510.0 → 547.5                   |
| Mac  | 100x100 | webgpu  | sustained-scroll | 92.5 → 90.0                 | 285.0 → 290.0                   |
| Mac  | 40x250  | webgl2  | dense-redraw     | 132.5 → 95.0                | 785.0 → 757.5                   |
| Mac  | 40x250  | webgl2  | sustained-scroll | 217.5 → 202.5               | 967.5 → 960.0                   |
| Mac  | 40x250  | webgpu  | dense-redraw     | 122.5 → 100.0               | 780.0 → 757.5                   |
| Mac  | 40x250  | webgpu  | sustained-scroll | 195.0 → 167.5               | 397.5 → 415.0                   |

The constant-N sweep holds 10,000 cells while changing R from 25 to 100 to 250. The index removes the growing search cost, while small viewports can pay more for hashing than for the original scan. There is no consistent end-to-end CPU win at 50 rows, and none is claimed. At 500 rows the WebGPU row plan falls from 115 to 50 µs on PC and 342.5 to 160 µs on Mac. Whole-frame bridge cost falls from 425 to 352.5 µs and 1010 to 897.5 µs respectively.

Every paired capture compares exact decoded RGBA, final text, input bytes, measured steps, built frames and submitted frames. The parity report records all 144 pairs. Native record and browser tests cover glyph edge cases separately. `ghostty-vt.wasm` remains byte-identical at SHA-256 `de411c7abb6af40aa9c077b79c373cf11952e7801133d0855cdf3723be5b1426`. The bridge was rebuilt with `bun run build:bridge --source /work/tmp/ghw-bridge-upstream --zig /home/shaul/.local/share/mise/installs/zig/0.16.0/zig`, using clean official source `7b11f3dca034d8d24369ad3856afe57946d7902a`.

## Reproduce

Use `bun run bench:renderer` with `BENCH_BASELINE_ROOT` pointing at the baseline source and these variables: `BENCH_BACKENDS=webgl2,webgpu BENCH_SCENARIOS=dense-redraw,sustained-scroll BENCH_STEPS=40 BENCH_WARMUP_STEPS=10 BENCH_REPETITIONS=3 BENCH_COLUMNS=<C> BENCH_ROWS=<R> BENCH_FONT_SIZE=8 BENCH_DPR=1 BENCH_OUTPUT=<report.json>`. Use the host reservation and quiet heavy queue described by the shared brief. Standalone index tests run with Zig 0.16.0 via `zig test scripts/row-index.zig`.
