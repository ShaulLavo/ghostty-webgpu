# F5 native acknowledgement

Status: Approved. Measured implementation: `00dc39ea49d91b82544aeaaad2837147ac58898a`. Baseline: `d2ed8989a`.

One JS-to-bridge call counts the remaining dirty rows through the native iterator, then calls upstream `ghostty_render_state_clean`. The count is published only after successful cleaning. The snapshot and cursor revision do not advance. It clears both dirty layers exactly as a successful complete acknowledgement did, including when the global flag is already clear or individual rows were already acknowledged. Granular native setters remain available for partial consumption.

A failed draw still leaves damage pending because the renderer does not acknowledge it. A failed count or clean call throws; no row setters run before clean. Synchronized output still acknowledges the retained pre-hold snapshot, and release exposes the pending terminal changes. This does not address the separate two-render-state damage ownership finding.

## Call counts and correctness

The instrumented 50-row regression runs both the legacy loop and the new path. A fully dirty acknowledgement takes **153 JS-to-core calls before**, versus **one JS-to-bridge call after**. The bridge performs 103 direct Wasm-to-Wasm core calls, including one native clean. For R rows and D dirty rows the old count is `2R+D+3`. The new JS boundary count is one regardless of R or D. Returning D exactly still requires an O(R) native iterator scan; this is not an O(1) total acknowledgement.

Five acknowledgement tests cover initial/empty and repeated acknowledgements, full and sparse counts, partial native clearing with an already clean global flag, a frame read without acknowledgement, failed cleaning with retry, synchronized-output holds, and measured boundary counts. The call-count probe wraps native exports for counting only; hardware timing runs do not use those wrappers.

## Hardware measurements

Raw evidence: `/work/reports/ghostty-webgpu-next-2026-10/bridge/f5/`. Headed Chromium 153.0.8010.12, RTX 3060 Ti on Linux 7.2.11-arch1-1 and Apple M1 on macOS 26.4. Three same-session counterbalanced repetitions, 80 measured updates after 10 warmups, both WebGL2 and WebGPU at 200×50. All 48 paired captures have byte-identical decoded RGBA, final text, written bytes, measured steps, built frames and submitted frames. The glyph-churn captures visibly include wide, combining and color glyphs and were inspected at original resolution. Existing frame and renderer tests also cover overhangs and hold/recovery paths.

These are experimental timings. The browser clock resolves 0.1 ms, so a zero aggregate can mean below its resolution. CPU is summed browser-process CPU divided by elapsed time, in percent of one core. The acknowledgement column divides each repetition's total acknowledgement time by its observed acknowledgement count, then takes the median.

| Host | Backend | Workload         | Ack before → after, µs | Browser CPU before → after, % |
| ---- | ------- | ---------------- | ---------------------- | ----------------------------- |
| PC   | webgl2  | cursor-movement  | 12.50 → 0.00           | 8.1 → 7.4                     |
| PC   | webgl2  | burst-output     | 6.25 → 3.75            | 12.6 → 11.9                   |
| PC   | webgl2  | sustained-scroll | 8.75 → 5.00            | 11.9 → 13.3                   |
| PC   | webgl2  | glyph-churn      | 8.75 → 3.75            | 58.5 → 61.6                   |
| PC   | webgpu  | cursor-movement  | 10.00 → 2.50           | 12.6 → 12.6                   |
| PC   | webgpu  | burst-output     | 6.25 → 1.25            | 15.6 → 14.1                   |
| PC   | webgpu  | sustained-scroll | 10.00 → 3.75           | 14.1 → 14.8                   |
| PC   | webgpu  | glyph-churn      | 10.00 → 3.75           | 65.2 → 63.7                   |
| Mac  | webgl2  | cursor-movement  | 45.00 → 3.75           | 29.1 → 25.0                   |
| Mac  | webgl2  | burst-output     | 22.50 → 7.50           | 34.7 → 35.3                   |
| Mac  | webgl2  | sustained-scroll | 27.50 → 5.00           | 28.7 → 32.0                   |
| Mac  | webgl2  | glyph-churn      | 10.00 → 2.50           | 69.3 → 69.2                   |
| Mac  | webgpu  | cursor-movement  | 27.50 → 7.50           | 33.5 → 32.8                   |
| Mac  | webgpu  | burst-output     | 35.00 → 10.00          | 35.2 → 35.9                   |
| Mac  | webgpu  | sustained-scroll | 26.25 → 8.75           | 35.1 → 34.6                   |
| Mac  | webgpu  | glyph-churn      | 15.00 → 2.50           | 74.9 → 73.5                   |

The micro timing improves while full-browser CPU remains noisy, especially under glyph churn. No broad end-to-end CPU improvement is claimed.

Both hardware runs preceded the implementation commit. The PC JSON records the baseline HEAD for both worktrees; the changed source and native bridge are identified by the saved bundle SHA-256 and bridge SHA-256. Mac source copies have no Git metadata and empty revision fields. The source came from the baseline and implementation worktrees named above. The native bridge was rebuilt through `bun run build:bridge` using Zig 0.16.0 and clean pinned official source `7b11f3dca034d8d24369ad3856afe57946d7902a`. The checked-in terminal wasm is unchanged at SHA-256 `de411c7abb6af40aa9c077b79c373cf11952e7801133d0855cdf3723be5b1426`.

## Verification and reproduction

`bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check` passed. The full unit gate passed 1110 Vitest tests, 482 Bun comparison tests and 4 checkpoint tests, with an existing skip. The later boundary-count addition passed all 5 acknowledgement tests plus typecheck, lint and format. Browser tests passed 86 tests with 2 existing skips across synchronized-output, held-output, WebGPU renderer and WebGL frame suites.

Run `bun run bench:renderer` with `BENCH_BACKENDS=webgl2,webgpu BENCH_SCENARIOS=cursor-movement,burst-output,sustained-scroll,glyph-churn BENCH_STEPS=80 BENCH_WARMUP_STEPS=10 BENCH_REPETITIONS=3 BENCH_BASELINE_ROOT=<baseline-source> BENCH_OUTPUT=<report.json>`, through the quiet runner or the Mac lock. The JSON retains acknowledgement counts, dirty-row totals and time, alongside full renderer metrics.
