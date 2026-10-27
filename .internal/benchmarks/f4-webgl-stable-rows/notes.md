# WebGL2 stable physical rows

Status: Approved. F4 and F11's concepts sentence. Control `46b13c564`; implementation `e134adc74`.

The frame builder owns a ring of physical rows. WebGL2 now requests that layout and sends its columns, row height, row offset and row count to both vertex shaders. Logical row position comes from the physical instance index plus the ring offset. The first scroll converts absolute coordinates to row-local coordinates and uploads the viewport once. Later scrolls preserve resident records.

WebGL2 has no buffer-capacity batches. Its instanced attributes cannot fetch an arbitrary record like WebGPU storage buffers. Two draw segments, with attribute pointers adjusted at the wrap, retain logical paint order for overlapping glyphs. A single draw in physical order changes blending at the wrap. A record texture would replace both attribute layouts and upload paths unnecessarily. The ring's scalar offset needs no row texture or uniform array.

A mapping change uses sparse physical byte ranges. Ordinary edits retain F7's 16 KiB clean-gap threshold. Row uniforms count toward uploaded bytes and trigger submission even when no instance bytes change. Resize resets row addressing. Frame capture, native acknowledgements and the bridge's logical changed-row list remain on the existing path.

## Execution and checks

The binding brief forbids nested agents. The implementation, architecture comparison and comment review are direct; the coordinator owns independent review and merge. The Model the Domain principle kept mapping in the existing ring representation. Prove It Works drove byte-for-byte full-repaint comparisons and real browser checks.

The throughput checkpoint has one owner for coupled renderer and shader changes. The first blockers were source inspection and a failing-first browser test. Independent host acquisitions use separate evidence directories. Shared state is the PC quiet queue and the Mac atomic job lock.

Task-owned resources are the `f4-webgl-stable-rows` and `f4-before` worktrees; disposable Chromium processes and profiles created by the existing runners; Mac `~/tmp/ghw-f4*` source, dependency, workload and result copies; the Mac job lock while held; and `/work/reports/ghostty-webgpu-next-2026-10/f4/`. No server, route, container or service is needed. Browser runners close their pages and browser in `finally`; remote shells release their own lock on exit. The Mac had no owner reservation, no agent lock, AC power and more than 2,000 seconds of HID idle time before setup. The PC had unrelated heavy-runner jobs, which remain untouched.

The original regression fails because WebGL2 does not request stable rows. Updated browser coverage checks Unicode scroll wraps against full repaints, overlapping glyph order, mapping-only updates, resize, and F7's gap splitting. Raw logs, frozen benchmark bundles and hardware pairs are retained under the report directory.

## Unrelated finding for the coordinator

Headed M1 Chromium exposes an existing screenshot-size assumption in `src/render/tests/zig-unicode.browser.test.ts`. Its shared capture fixture returns 640×73 pixels for a 640×72 canvas, so all 58 cases fail before their content comparisons. The unchanged control at `46b13c564` reproduces both WebGPU and WebGL2 ASCII failures with `GHOSTTY_BROWSER_HARDWARE=1 bun run test:browser src/render/tests/zig-unicode.browser.test.ts -t 'submits ASCII entirely'`. Candidate and control logs are `headed-mac.log` and `headed-mac-control.log` under the raw report directory. This is separate from the row implementation; 90 other headed Mac checks pass, including the WebGL2 Unicode wrap comparison and emoji tests. A follow-up should inspect the fractional canvas position and screenshot clipping in that file's `displayedPixels` helper, preserve original-resolution evidence, and avoid changing renderer geometry to accommodate the screenshot.

## Primary PC gate

The qualified counterbalanced control uses 120 measured updates after 20 warmup updates, four repetitions, 200×50 cells, DPR 2, one terminal, headed Chromium 153.0.8010.12 on Linux 7.2.11-arch1-1 and the NVIDIA RTX 3060 Ti through ANGLE/OpenGL ES 3.2, driver 615.78.08. The existing runner reports `performanceQualified: true`. Control source is `46b13c56409d0022c8ff95bde33917aee0517d9f`; measured implementation is `e134adc743ae51a5a2e3d7fca8df2a8cdb7c90a4`. Later commits add tests and measurement receipts only.

| Per logical update                |   Control | Stable rows |     Change |
| --------------------------------- | --------: | ----------: | ---------: |
| Scroll renderer stage             | 0.3442 ms |   0.1502 ms |     −56.4% |
| Scroll bridge stage               | 0.2215 ms |   0.0523 ms |     −76.4% |
| Scroll uploaded bytes             |     5,280 |         128 |     −97.6% |
| Scroll browser-process-family CPU | 1.7292 ms |   1.5208 ms |     −12.0% |
| Sparse edit renderer stage        | 0.0996 ms |   0.1056 ms | +0.0060 ms |
| Dense redraw renderer stage       | 0.7831 ms |   0.7694 ms | −0.0137 ms |

The ≥30% gate measures the renderer's scroll stage, as E5 specifies. Process-family CPU includes browser and GPU-process work and improves less. F7 already reduced the control's upload bytes relative to the study's older 941 KB figure. The remaining saving comes from retained row records, fewer upload calls and cheaper bridge reuse.

The sparse difference varies by pair from −24 to +25 microseconds. Its mean is +6 microseconds; the four-pair 95% t interval is −29 to +41 microseconds. This does not resolve a sparse regression. The broader matrix is experimental, with two short counterbalanced repetitions per cohort, and retains every result rather than claiming each noisy percentage is a stable change.

The M1 runs use macOS Darwin 25.4.0, headed Chromium 153.0.8010.12 and ANGLE Metal on Apple M1. Staged copies have no Git metadata; `mac-provenance.txt` verifies the three changed runtime files and concepts page against the exact PC source hashes. Frozen bundle and wasm hashes remain in every packet.

Presentation counts remain unmeasured. Parsed calls and bytes, acknowledgements and submitted frames are separate recorded checks. Screenshots establish content, not presentation timing. This preserves the baseline packet's timing-endpoint limitation.

## Reproduction

Create an exclusive detached control worktree at `46b13c56409d0022c8ff95bde33917aee0517d9f`, install the frozen lockfile, then run `prepare-harness.py <control-worktree>` from this directory. It reuses the baseline packet's archived instrumentation without changing runtime source. Run `run-pairs.sh <pc-or-mac> <output> <control-worktree> <candidate-worktree> <workloads>` under the PC quiet queue or Mac lock. The workload directory is the baseline packet's `/work/reports/ghostty-webgpu-next-2026-10/p0a/workloads/`, including ASCII, NTCharts heatmap and OpenTUI plasma.

The primary gate additionally sets `BENCH_BACKENDS=webgl2`, `BENCH_SCENARIOS=sustained-scroll,sparse-edit,dense-redraw`, `BENCH_STEPS=120`, `BENCH_WARMUP_STEPS=20`, `BENCH_REPETITIONS=4`, `BENCH_TRACE=1`, `BENCH_DPR=2`, `BENCH_DEFAULT_GPU=1`, `BENCH_BASELINE_ROOT=<control>` and `F4_CANDIDATE_ROOT=<candidate>`, then runs `bun run bench:renderer` in the instrumented control worktree. Check at least 2 GiB free PC VRAM before each headed browser.

Run `python3 summarize.py /work/reports/ghostty-webgpu-next-2026-10/f4` with Pillow installed to regenerate `pairs.csv` and `summary.json`. The checker compares exact decoded screenshot pixels, text hashes, parsed calls and bytes, acknowledgements and submission counts. It skips interrupted cohorts without a `.done` receipt.

## Final verification

All 33 hardware packets, comprising 332 source pairs, have identical decoded screenshot pixels, text hashes, parser-call counts, input bytes, native acknowledgements and submitted-frame counts. The Mac transfer also matches the source host's SHA-256 manifest. The checked-in `pairs.csv` and `summary.json` retain every cohort and separate presentation as unmeasured.

The full PC browser suite passes all 63 files, with 1,042 tests passed and 7 skipped. Root build, typecheck, lint, format check, unit tests and the site docs checker pass. The first complete browser attempt lacked extension package builds, causing a Vite overlay and cascading screenshot/click failures. Building `packages/line-editor` and `packages/shaders`, as the normal verification script does, resolves that setup failure. The rolling-identical-row test now warms the one-time coordinate conversion and asserts zero instance-buffer writes plus the 32-byte mapping update. The final browser run and the final static checks include these assertions.

The PC matrix was resumed after the runner's ten-minute quiet limit stopped acquisition. Completed `.done` cohorts were preserved; the remaining external workloads ran under a fresh quiet lease. The final exporter excludes interrupted cohorts. Raw logs retain the timeout and failed setup attempts.
