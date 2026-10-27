# Binary worker row deltas

Decision: **REJECT** this positional row-delta prototype. Date: 2026-10-27. Lane X4b.

This runs the "Delta-only follow-up" protocol fixed in [PR #17](https://github.com/ShaulLavo/ghostty-webgpu/pull/17), head `20055add`. It removes pooling from the earlier experiment. Both arms keep one dedicated worker, one owned runtime and one direct WebGL2 renderer context per terminal. There is no shared framebuffer or copy pass.

The host-time gate passes in only 2 of 12 conditions. Worker CPU regresses in 3 conditions, total resident memory regresses in 9, acknowledgement p95 misses in 2, and p99 misses in 4. The host-time failure is decisive even without the smaller memory differences. No production change is promoted.

## Fixed comparison

The common production source is main at `970d701e4`. Measured experiment source is `b1c6838502d2c8cce17e4634efbbd89d89c83e45`. The runner and control helper derive from the pooling prototype at `9632aa47`. Production source, wasm, bridge and renderers are unchanged. Build-time adapters instrument both arms and replace only frame transport in the candidate.

The unchanged control sends its existing complete structured-clone frame and runs its existing ownership restoration. The candidate sends binary changed rows. Each row carries exact UTF-16 text, separate cell strings and continuation flags. Small frame metadata still uses structured clone. The host reconstructs the complete projection and summary, including the summary's patch list, and reuses frozen unchanged rows. This is a complete text-row representation rather than the pooling sketch's row-text-only shortcut. It still materializes and compares full rows inside the worker.

PC, Omarchy Linux, Intel Core i7-14700K, NVIDIA GeForce RTX 3060 Ti. Headed Chromium 153.0.8010.12 reported `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Ti/PCIe/SSE2, OpenGL ES 3.2 NVIDIA 615.78.08)`. The shared runner granted a quiet bench slot. The runner checked at least 2 GiB of free VRAM before each browser.

All twelve prescribed conditions ran twice, with control/delta order in repetition zero and delta/control in repetition one. A pair shares one browser and closes it before the next pair. The grids are 200×50 and 80×24, DPR 2, JetBrains Mono 13. The three workloads and input chunks, eight warmup steps, sixty measured steps, and busiest-terminal schedule match the pooling experiment. Terminal zero writes every step; siblings write every fourth step. The source workload hashes are checked before replay.

Numbers are experimental. Each value below is the mean of its two per-run measurements. Ratios divide those means, including mean per-run p95 and p99. Host time is main-thread task milliseconds per delivered frame. Worker CPU is dedicated-thread seconds per sample. Memory is Chrome-family PSS plus measured device-VRAM growth from the pair's pre-browser baseline, including all worker isolates and GPU allocations.

| Workload / terminals / grid | Host ms/frame, control → delta | Worker CPU seconds | Total resident MiB | Ack p95 / p99 ratio |
| --------------------------- | -----------------------------: | -----------------: | -----------------: | ------------------: |
| mixed-edit/4/200x50         |                  0.851 → 0.258 |      0.120 → 0.120 |        1101 → 1117 |       0.88× / 0.91× |
| sustained-logs/4/200x50     |                  0.891 → 0.899 |      0.205 → 0.185 |        1149 → 1147 |       0.80× / 0.88× |
| unicode-varied/4/200x50     |                  1.016 → 0.880 |      0.240 → 0.215 |        1219 → 1221 |       0.86× / 1.00× |
| mixed-edit/16/200x50        |                  0.796 → 0.192 |      0.435 → 0.490 |        2569 → 2483 |       1.25× / 1.36× |
| sustained-logs/16/200x50    |                  0.910 → 0.863 |      0.865 → 0.805 |        2669 → 2674 |       0.98× / 1.15× |
| unicode-varied/16/200x50    |                  0.916 → 0.891 |      1.010 → 0.905 |        2776 → 2812 |       1.59× / 1.28× |
| mixed-edit/4/80x24          |                  0.330 → 0.212 |      0.070 → 0.070 |          778 → 787 |       1.00× / 0.61× |
| sustained-logs/4/80x24      |                  0.367 → 0.385 |      0.070 → 0.090 |          811 → 807 |       1.08× / 1.06× |
| unicode-varied/4/80x24      |                  0.378 → 0.374 |      0.100 → 0.100 |          975 → 981 |       1.00× / 1.13× |
| mixed-edit/16/80x24         |                  0.268 → 0.150 |      0.280 → 0.240 |        1457 → 1479 |       0.89× / 1.93× |
| sustained-logs/16/80x24     |                  0.369 → 0.356 |      0.315 → 0.325 |        1507 → 1562 |       1.15× / 1.45× |
| unicode-varied/16/80x24     |                  0.438 → 0.379 |      0.390 → 0.380 |        2185 → 2193 |       0.89× / 1.13× |

The compact [results](worker-binary-delta-results.json) include every condition's gate flags, absolute acknowledgement values, and joined timing quantiles. Worker CPU has 10 ms tick resolution. Memory differences include driver caching and compositor variation. Those limitations do not rescue the missing host-time reduction across ten conditions.

## Output and API evidence

Each arm parsed, submitted and delivered all **4,680** measured updates. Parsed counts mean successful synchronous native writes acknowledged by the existing request path. Submitted counts are the direct renderer's submission callbacks; delivered counts are the matching host frame callbacks. The instrument advances only after the scheduled writes' frames arrive. True compositor-presented counts remain unresolved and are recorded as `null`; final decoded screenshots verify pixels, not presentation latency.

All **240 paired terminal comparisons** match for final text, decoded RGBA pixels, complete final snapshots and summaries, native event contents/order, input byte counts and input ordering. The raw input hashes and byte totals include the identical warmup. Counts and CPU/task spans exclude warmup. The mixed workload includes wide CJK, combining accents, an overhanging mathematical italic glyph and color emoji.

A separate headless smoke run roundtrips every candidate frame through an independent decoder and compares the complete projection and summary before sending it. Both grids pass. A native-backed codec test verifies cell-only changes with unchanged row text, continuation changes, lone surrogates, selection active/cleared, frozen ownership and preservation of older snapshots. An initial failed smoke exposed a decoder cache accidentally shared between terminals. The corrected adapter keys decoder state by terminal identity, and the rerun passes.

The experiment does not certify the full public DOM observer, link, selection-gesture and accessibility integrations under the candidate transport. The existing 133 worker browser tests pass against the unchanged packaged library. Those results are not presented as candidate-transport coverage. Full API qualification is still required before any production promotion; numerical gates already reject this candidate independently.

## Timing joins and the Unicode tail

Every message receipt records terminal identity and control watermark. Frame receipts also record frame identity. The packet joins worker queue entry, worker execution start, parser reply publication, frame encoding start/end, and host receive/handler completion. Both realms use epoch-based performance clocks. The frame publication-to-host gap includes serialization, transport and scheduling; the instrument cannot separate those costs. Queue entry is handler entry on the worker, so it excludes time waiting for the browser to dispatch that message.

Chromium GC trace events include process/thread identities and trace timestamps, with a clock-sync marker bracketed by epoch readings. Every live worker CDP target records its terminal identity and heap. Heap is reported separately and is not added to PSS a second time.

Independent workers do not remove every latency miss. For 16-terminal 200×50 Unicode, mean per-run acknowledgement p95 is 1.35 → 2.15 ms, or 1.59×, and p99 is 2.70 → 3.45 ms, or 1.28×. The original pooling miss at 4-terminal 200×50 Unicode is absent here, with p99 1.05 → 1.05 ms, but a different Unicode condition now misses.

The worst delta acknowledgement in each repetition is its first measured write, control 10. End-to-end durations are 3.50 and 3.40 ms. Worker queue wait rounds to zero, execution-to-reply is 0.50 and 0.40 ms, and pre-post-to-host-receive is 2.90 ms in both. This places most of those tails after the worker's parse/reply work, rather than in the measured request chain. It does not isolate browser transport from scheduling or serialization. Dedicated-worker GC intervals overlap both tail windows, but the trace does not map a GC thread to the affected terminal, so that overlap is not a causal attribution.

Across the 120 busiest-terminal Unicode samples, frame encoding p95 is 1.30 ms and host frame handling p95 is 0.90 ms in the candidate, compared with 0 and 0.20 ms in the control. The control's pre-post-to-host frame gap p95 is 3.60 ms versus 2.60 ms for deltas. These costs explain why lower transfer work does not imply the required host-time win. A write's parse acknowledgement precedes its later frame encoding; these measurements do not charge that later encoding directly to the acknowledgement.

## X7 compatibility

The [X7 worker-publication design](https://github.com/ShaulLavo/ghostty-webgpu/blob/docs/coherent-publication/.internal/coherent-publication.md) uses the right production key. Its native text revision guarantees equality of text, cell strings and continuation flags even when a row moves. A successor should send the ordered native revision list and payloads only for revisions absent from the host cache, then rewrap the cached content at its new viewport row.

This measured prototype compares rows at their viewport `y`. It does not reuse X7's key because the unchanged main base lacks `bridge_read_retained_revisions` and the corresponding displayed-frame revision API. Importing that core/bridge change during the running cohort would change the shared base and invalidate this isolated comparison. A separate JavaScript imitation of the native revision would introduce a competing identity scheme, so none was added. There is no production row-identity API to reconcile or land here.

The positional design resends moved rows on scroll. X7 can remove that work and the full-row comparison, and its result remains **undecided** by this packet. The next production experiment should consume X7's actual revisions after its prerequisite exports are available in both arms, retain exact cells and continuation flags, bound the host cache to readable frames, and rerun these gates. It also needs candidate-transport tests for WebGL2 and WebGPU workers, held output, resize and recovery, observers, links, selection, accessibility, acknowledgement errors and disposal. This note does not approve that implementation or claim its performance.

## Reproduce and verify

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
bun install --frozen-lockfile
bun /work/platform-production/heavy/current/run.js --class bench --quiet 'X4b paired binary-delta hardware' -- env WORKER_DELTA_REPETITIONS=2 WORKER_DELTA_STEPS=60 WORKER_DELTA_OUTPUT=/work/reports/ghostty-webgpu-next-2026-10/x4b-binary-deltas/hardware.json bun scripts/worker-delta-benchmark.ts
node scripts/worker-delta-summary.mjs /work/reports/ghostty-webgpu-next-2026-10/x4b-binary-deltas/hardware.json .internal/worker-binary-delta-results.json
```

Run from an exclusive checkout of `research/worker-binary-deltas`. The runner serves assets through request interception and starts no server. `WORKER_DELTA_HEADLESS=1 WORKER_DELTA_PARITY=1 WORKER_DELTA_COUNTS=4 WORKER_DELTA_FIXTURES=mixed-edit WORKER_DELTA_STEPS=4 WORKER_DELTA_REPETITIONS=1` selects the correctness-only shadow run. Its timings do not qualify as performance evidence.

Verification passed `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:unit`, `bun run test:browser src/worker/terminal.browser.test.ts`, `bun run --cwd site docs:check`, and `bun test ./.internal/worker-delta-prototype/codec.test.ts`. Results were 1,114 unit tests, 482 benchmark-tool tests, four checkpoint tests, 133 worker browser tests, seven site tests, and the codec ownership test. One existing unit test is skipped. Existing lint and Vite warnings remain in unchanged files.

## Evidence and cleanup

Compressed raw receipts, GC evidence, 480 hardware screenshots, corrected parity evidence and logs stay under `/work/reports/ghostty-webgpu-next-2026-10/x4b-binary-deltas/` for coordinator review. The raw receipt is `hardware.json.gz`. Its uncompressed SHA-256 is `e150410bb0d7ca124ba721c961753711fe86ea30f176bf9844040047abae3f49`.

The runner closes each page and browser in `finally`, disconnects CDP, and removes its short `/work/tmp/x4b-*` browser scratch directory. The debug port is closed and no task browser scratch remains after the hardware cohort. No server, route, container, remote copy or deployment was created. The exclusive checkout and its build/dependency artifacts are removed after the PR is pushed. Retained evidence is owned by the coordinator until review is complete; its final size is recorded in the task report.
