# Worker pool experiment

Decision: **REJECT** this WebGL2 prototype. Date: 2026-10-27. Plan item X4, study experiment E6.

The pool cuts host work and worker CPU substantially, with equal text, pixels, and delivered updates. It does not meet the 16-terminal total-memory requirement. Five of six cases save only 12–14%; only 80×24 Unicode reaches 30%. A 4-terminal Unicode p99 case also exceeds the latency limit. Do not schedule a production pool PR from this result.

The experiment leaves production source unchanged. The [prototype and reproducer](https://github.com/ShaulLavo/ghostty-webgpu/tree/research/worker-pool) stay on `research/worker-pool`. The measured source is `8ff7f602a7a708a8cbab43eede1aaba0c9e16e3f`. Both arms use the package source from `d2ed8989a`; the control runs its existing `WorkerTerminalExecution` and `TerminalWorkerRuntime` with WebGL2. No core, bridge, or renderer implementation was patched.

## Gates

| Requirement                                                | Result                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Host main-thread time per published frame −50%             | Pass. Reductions of 65–93% across all twelve conditions.                                                                                        |
| Total memory at 16 terminals −30%                          | Fail. Reductions of 12–14% in five conditions; 38% for 80×24 Unicode.                                                                           |
| Equal text, pixels, and delivered updates                  | Pass in all 24 paired samples. Each arm delivered all 4,680 measured updates.                                                                   |
| Busiest-terminal p95 and p99 acknowledgement ≤1.2× control | Fail for 4-terminal 200×50 Unicode p99. Mean per-run p99 is 0.75 → 1.55 ms, or 2.07×. All mean p95 ratios pass; the other mean p99 ratios pass. |

## Measurements

PC, Omarchy Linux, Intel Core i7-14700K, NVIDIA GeForce RTX 3060 Ti. Headed Chromium 153.0.8010.12 reported `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Ti/PCIe/SSE2, OpenGL ES 3.2 NVIDIA 615.78.08)`. All terminals use DPR 2. These numbers are experimental, from two counterbalanced repetitions.

Values below are control → pool. Time is main-thread task milliseconds per delivered frame. Memory is MiB of Chrome-family proportional resident memory plus the measured device-VRAM change from the pair's pre-browser baseline. The last two columns are pool/control acknowledgement ratios. Each value is the arithmetic mean of its two per-run measurements; ratios divide those means.

| Workload       | Terminals | Grid   | Host ms/frame | Total resident MiB | Ack p95 ratio | Ack p99 ratio |
| -------------- | --------: | ------ | ------------: | -----------------: | ------------: | ------------: |
| mixed-edit     |         4 | 200x50 | 1.030 → 0.126 |        1158 → 1105 |         0.07× |         0.07× |
| sustained-logs |         4 | 200x50 | 0.887 → 0.133 |        1211 → 1128 |         0.33× |         0.44× |
| unicode-varied |         4 | 200x50 | 1.002 → 0.156 |        1225 → 1141 |         0.40× |         2.07× |
| mixed-edit     |        16 | 200x50 | 0.831 → 0.062 |        2670 → 2357 |         0.36× |         0.43× |
| sustained-logs |        16 | 200x50 | 0.928 → 0.077 |        2752 → 2386 |         0.15× |         0.54× |
| unicode-varied |        16 | 200x50 | 0.893 → 0.089 |        2800 → 2439 |         0.29× |         1.00× |
| mixed-edit     |         4 | 80x24  | 0.357 → 0.103 |          791 → 755 |         0.57× |         0.45× |
| sustained-logs |         4 | 80x24  | 0.422 → 0.101 |          804 → 765 |         0.33× |         0.43× |
| unicode-varied |         4 | 80x24  | 0.423 → 0.147 |          990 → 767 |         0.29× |         0.33× |
| mixed-edit     |        16 | 80x24  | 0.281 → 0.053 |        1496 → 1315 |         0.50× |         0.55× |
| sustained-logs |        16 | 80x24  | 0.355 → 0.062 |        1490 → 1283 |         0.15× |         0.12× |
| unicode-varied |        16 | 80x24  | 0.414 → 0.065 |        2165 → 1347 |         0.08× |         0.06× |

The 16-terminal worker and host-memory breakdown follows. Worker CPU is seconds over the measured sample. Heap includes each live worker's V8 used heap, embedder heap, and backing storage. PSS already includes these allocations; heap is not added to PSS again. The last column gives busiest-terminal acknowledgement p50/p95/p99 in milliseconds.

| Condition                | Worker CPU seconds | Worker heap MiB | Host PSS MiB | Ack p50/p95/p99 ms              |
| ------------------------ | -----------------: | --------------: | -----------: | ------------------------------- |
| mixed-edit/16/200x50     |      0.435 → 0.090 |    121.8 → 27.1 |    915 → 573 | 0.25/0.55/0.70 → 0.10/0.20/0.30 |
| sustained-logs/16/200x50 |      0.830 → 0.200 |    164.5 → 15.6 |    997 → 601 | 0.35/2.40/3.15 → 0.10/0.35/1.70 |
| unicode-varied/16/200x50 |      0.975 → 0.245 |    126.6 → 42.1 |   1036 → 651 | 0.30/1.70/2.75 → 0.10/0.50/2.75 |
| mixed-edit/16/80x24      |      0.235 → 0.060 |    115.8 → 48.1 |    739 → 537 | 0.20/0.40/0.55 → 0.10/0.20/0.30 |
| sustained-logs/16/80x24  |      0.315 → 0.090 |     134.7 → 9.5 |    783 → 523 | 0.30/1.65/2.55 → 0.10/0.25/0.30 |
| unicode-varied/16/80x24  |      0.375 → 0.095 |    730.6 → 60.7 |   1455 → 579 | 0.35/2.55/4.75 → 0.10/0.20/0.30 |

Absolute values for all conditions and both repetitions are in [worker-pool-results.json](worker-pool-results.json). The raw packet, 480 screenshots, and corrected headless checks are under `/work/reports/ghostty-webgpu-next-2026-10/x4-worker-pool/`. The raw hardware receipt SHA-256 is `5148d4d4a153a4ce20396214fc42a4b62217d3e70101a2b476be8c151bb41e06`.

## What ran

One pooled worker owns one `GhosttyRuntime` and one WebGL2 context. Every session retains its native terminal, render state, atlas, instance buffers, and framebuffer. The shared context renders into that framebuffer and copies the result to the session's display canvas. The copy is included in worker CPU and memory. It avoids the per-worker WebGL context limit encountered by the first sketch, which lost early contexts at 16 sessions.

The pool transfers binary UTF-8 row deltas. An eight-byte header precedes twelve bytes per changed row and the row text. The host retains unchanged rows. The control publishes its existing full structured-clone frame graph and restores readonly values through the existing host path.

Each pair shares a browser session, source, input chunks, geometry, font, and DPR. Order is control/pool in repetition zero and pool/control in repetition one. Each pair closes its browser before the next opens. The shared PC runner grants a quiet benchmark slot; free VRAM is checked before every headed browser, with a 2 GiB minimum.

The page performs eight warmup steps and sixty measured steps. Terminal zero writes at every step; each sibling writes every fourth step. Writes acknowledge parser acceptance. The instrument then waits for that step's frame before advancing, so every measured write produces one delivered update. This is a paced workload, not an unbounded backlog or presentation-latency measurement.

The cohort includes a mixed edit with ASCII, wide CJK, combining accents, an overhanging mathematical italic glyph, and color emoji. It also replays the study's `sustained-logs` and `unicode-varied` chunks, checking their existing SHA-256 values. The replay uses identical bytes in both requested grids. There are 240 per-terminal text and decoded-RGBA comparisons across the 24 paired samples; all match.

A direct CDP WebSocket attaches to every live dedicated-worker target and runs `Runtime.getHeapUsage`. Page heap alone is never treated as total heap. Worker CPU comes from Linux dedicated-worker thread user/system ticks at 100 Hz. `Performance.getMetrics` uses thread ticks for page task time. Startup, heap queries, screenshots, and lifecycle probes are outside the timed span. The custom runner adds the target attachment and pooled-session endpoints that the existing single-terminal renderer runner does not expose.

## Lifecycle and limits

At both 4 and 16 sessions, the probe disposes the last session, writes through the survivors, changes terminal zero to font size 15 and DPR 1.25, then loses and restores the shared context. All surviving sessions publish recovery frames. The disposed session publishes none. The shared context survives individual terminal disposal. Corrected headless checks and the hardware lifecycle probes pass without reported errors.

The memory result is the decisive failure. Host PSS falls by 27–60% at 16 terminals, but the total also contains GPU resources. The pool keeps per-terminal atlases and buffers and adds framebuffer/copy targets. Counting only the worker heap or host PSS would conceal most of the memory retained by this prototype.

Device-VRAM deltas can include compositor changes and driver caching. Counterbalanced pairs reduce order bias, and host PSS is reported separately. Worker CPU has 10 ms tick resolution, so the smallest CPU samples are descriptive. No confidence interval or energy claim is made. Each run has only sixty busiest-terminal acknowledgements, so its p99 is the largest observation. The isolated p99 miss is a tail warning, not proof of a persistent latency regression; the memory failure stands independently.

This sketch transports row text, not the complete public API. A production binary protocol would also have to retain cell boundaries, continuation flags, cursor and layout identities, selection, link semantics, and event ordering. The WebGPU variant, true compositor presentation, sustained-backlog fairness, and the full L6 workload set were not tested. This rejects the measured WebGL2 framebuffer/copy design, not every possible worker pool or binary publication scheme.

## Reproduce and verify

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
git switch research/worker-pool
bun install --frozen-lockfile
bun /work/platform-production/heavy/current/run.js --class bench --quiet 'X4 paired hardware' -- env WORKER_POOL_REPETITIONS=2 WORKER_POOL_STEPS=60 WORKER_POOL_OUTPUT=/work/reports/ghostty-webgpu-next-2026-10/x4-worker-pool/hardware.json bun scripts/worker-pool-benchmark.ts
node scripts/worker-pool-summary.mjs /work/reports/ghostty-webgpu-next-2026-10/x4-worker-pool/hardware.json /work/reports/ghostty-webgpu-next-2026-10/x4-worker-pool/summary.json
```

Use an exclusive checkout for reproduction. The browser runner has bounded operations and closes every browser on success, failure, or timeout. It starts no dev server or permanent route.

Verification passed `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:unit`, `bun run test:browser src/worker/terminal.browser.test.ts`, and `bun run --cwd site docs:check`. Results were 1,106 unit tests, 482 benchmark-tool tests, four checkpoint tests, 133 worker browser tests, and seven site tests. Existing lint and Vite warnings remain in unchanged files. The prototype's corrected browser checks and measured hardware cohort pass output and lifecycle prerequisites. Temporary builds, smoke scratch, disposable browsers, and worktrees are removed after the branches are pushed; raw review evidence remains in the report directory.
