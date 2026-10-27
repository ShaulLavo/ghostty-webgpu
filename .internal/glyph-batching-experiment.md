# X2 glyph batching experiment

Decision: **REJECT**. Date: 2026-10-27. This closes plan X2 and study E3 at their existing gate. Do not ship the batching or warmup prototype.

Batching reduces glyph-raster time by 10.8–31.2% across the requested matrix. No case reaches the required 40%. The full-key glyph index and grayscale/color split remain correct. All 48 primary pairs have equal atlas page SHA-256 hashes and identical screenshot PNG bytes. The production rasterizer stays unchanged.

## What ran

One 200×50 terminal, DPR 1 and 2, WebGPU and WebGL2, on the RTX 3060 Ti PC and M1 Mac. Each cohort uses three same-session pairs in AB, BA, AB order, eight warmup updates and 64 measured updates per arm. The PC used the shared quiet queue with more than 2 GiB free VRAM before each headed browser. The Mac used the shared lock and AC power. Chromium was 153.0.8010.12 on both hosts. WebGPU reported hardware adapters, not fallback adapters. See [protocol](glyph-batching/protocol.md) for workload and endpoint definitions.

The control is `cb607d878` from origin/main. The prototype started at `46b13c564`; the subsequent main changes used by the control did not change its production rasterizer, atlas, bridge or GPU renderers. The [prototype patch](glyph-batching/prototype.patch) and [measurement patch](glyph-batching/measurement.patch) identify the exact changes. The raw runner artifacts also contain browser-bundle SHA-256 hashes, wasm hashes and adapter metadata. Mac source staging has no Git metadata, so its raw `sourceArtifacts.revision` is empty. The recorded base commits and patch checksums supply that missing provenance rather than presenting an empty string as a source revision.

The prototype packs independently clipped, padded glyph regions up to 8192 pixels wide. Both white and black color-classification probes share the readback. Edge contact falls back to the unchanged bounded-padding path. Foreground-dependent color layers retain their full key and original recoloring path. A browser test confirms one readback for 24 cold monochrome glyphs, including both probes.

## Raster-time results

Times are median milliseconds per update. Reduction is the median of the three per-pair ratios, so it need not equal the ratio of the two displayed medians. Every row has 3/3 equal screenshot and atlas pairs.

| Host | DPR | Backend | Workload    | Raster before ms/update | Raster batch ms/update | Reduction | Equal screen/atlas pairs |
| ---- | --- | ------- | ----------- | ----------------------- | ---------------------- | --------- | ------------------------ |
| pc   | 1   | webgl2  | glyph-churn | 3.448                   | 2.672                  | 26.2%     | 3/3                      |
| pc   | 1   | webgl2  | cold-cache  | 1.441                   | 1.078                  | 28.3%     | 3/3                      |
| pc   | 1   | webgpu  | glyph-churn | 3.325                   | 2.572                  | 22.7%     | 3/3                      |
| pc   | 1   | webgpu  | cold-cache  | 1.473                   | 1.100                  | 25.0%     | 3/3                      |
| pc   | 2   | webgl2  | glyph-churn | 6.266                   | 5.544                  | 10.8%     | 3/3                      |
| pc   | 2   | webgl2  | cold-cache  | 3.886                   | 3.453                  | 10.9%     | 3/3                      |
| pc   | 2   | webgpu  | glyph-churn | 6.364                   | 5.522                  | 13.6%     | 3/3                      |
| pc   | 2   | webgpu  | cold-cache  | 4.033                   | 3.413                  | 14.9%     | 3/3                      |
| mac  | 1   | webgl2  | glyph-churn | 4.255                   | 3.683                  | 14.5%     | 3/3                      |
| mac  | 1   | webgl2  | cold-cache  | 2.300                   | 1.642                  | 28.6%     | 3/3                      |
| mac  | 1   | webgpu  | glyph-churn | 4.408                   | 3.731                  | 11.1%     | 3/3                      |
| mac  | 1   | webgpu  | cold-cache  | 2.105                   | 1.430                  | 31.2%     | 3/3                      |
| mac  | 2   | webgl2  | glyph-churn | 7.697                   | 5.980                  | 23.0%     | 3/3                      |
| mac  | 2   | webgl2  | cold-cache  | 5.175                   | 3.786                  | 27.0%     | 3/3                      |
| mac  | 2   | webgpu  | glyph-churn | 7.759                   | 5.933                  | 23.5%     | 3/3                      |
| mac  | 2   | webgpu  | cold-cache  | 5.106                   | 3.616                  | 28.9%     | 3/3                      |

The [stage table](glyph-batching/stages.md) records write, bridge and acknowledgement costs separately from raster time. Upload and encode/submit CPU were not separately timed in this probe.

The separate idle-warmup cohort repeats the same matrix. It warms printable ASCII in regular, bold, italic and bold italic after the first content callback, a further animation frame and an idle callback. Warmup always began after that callback. Its large single callback is a reason to reject this warmup implementation too. It needs a bounded idle budget, cancellation on disposal/font changes, and a presentation-qualified startup test before reconsideration.

| Host | DPR | Backend | First callback control ms | First callback warm arm ms | Warmup callback ms |
| ---- | --- | ------- | ------------------------- | -------------------------- | ------------------ |
| pc   | 1   | webgl2  | 54.2                      | 52.6                       | 20.0               |
| pc   | 1   | webgpu  | 136.1                     | 106.6                      | 18.8               |
| pc   | 2   | webgl2  | 51.1                      | 51.0                       | 49.3               |
| pc   | 2   | webgpu  | 142.0                     | 111.6                      | 48.4               |
| mac  | 1   | webgl2  | 67.3                      | 65.8                       | 19.8               |
| mac  | 1   | webgpu  | 61.2                      | 73.1                       | 19.1               |
| mac  | 2   | webgl2  | 75.4                      | 72.1                       | 50.0               |
| mac  | 2   | webgpu  | 83.5                      | 71.1                       | 49.4               |

These are medians over six new-page startup observations per backend/DPR arm across the two workload cases. They are experimental callback endpoints. Scheduling warmup after a callback does not prove that it starts after compositor presentation. The warmup callback can occupy a substantial fraction of a frame, or several frames.

## Correctness and endpoints

The focused rasterizer browser suite passes 13 tests on the PC and headed Mac Chromium. It compares bitmap bytes and bearings for DPR 1 and 2, all four style combinations, CJK fallback, combining marks, color emoji and ZWJ emoji. It also covers low-line-height clipping, long overhang retries, adjacent-slot isolation, and a synthetic font with fixed white/black/gray and currentColor layers. Representative PC and Mac screenshots were inspected at original resolution.

Each primary pair processes 64 measured writes. Glyph churn parses 15,488 bytes; cold cache parses 153,792 bytes. Parsed writes, submitted frames, acknowledgement counts and observer callbacks are checked separately by the [analysis script](glyph-batching/analyze.mjs). The first-frame endpoint is `onFrame`, not GPU completion or physical presentation. Matched presentation-event counts are **unresolved**. Screenshots do not fill that gap. The runner's hardware/process qualification is sufficient for the measured raster-time rejection, but this is not a production-qualified presentation or input-latency claim.

Raw evidence and exact controller logs are retained under `/work/reports/ghostty-webgpu-next-2026-10/x2/`. [Compact receipts](glyph-batching/results.json) preserve the environment, counts, timing totals and equality hashes in the repository. [Reproduction commands](glyph-batching/reproduce.md) explain how to apply the research patches and rerun the pairs. No source or benchmark instrumentation from the experiment is enabled in the package.

## Why stop here

The Prove It Works principle kept atlas bytes and screenshots beside timings. Build the Lever produced the rerunnable analyzer and research patches. Foundational Thinking kept full-key ownership in the native builder and scratch geometry inside the rasterizer. Sequence Work into Verifiable Units put bitmap parity before hardware measurements. No additional agent was started, as required by the lane brief.

The experiment removes most readback calls for monochrome misses, but keeps per-glyph painting, two color probes, bounds scans and bitmap copies. These measurements do not isolate which remaining operation dominates. Further tuning is a new hypothesis, not a reason to lower the 40% gate. Do not promote this prototype on its smaller improvement.

## Validation and retained evidence

The final report branch passes `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run verify:extensions`, `bun run test:unit`, the full `bun run test:browser`, and `bun run --cwd site docs:check`. The full browser run has 64 passing files, 1,089 passing tests and 7 skipped tests. All heavy local commands ran through the shared queue. Exact output is in `final-gates.log` under the raw evidence directory.

The raw evidence occupies 4.5 MiB after duplicate screenshot paths are hard-linked to eight unique PNGs. It is retained for the coordinator's review and can be removed after the decision and receipts are accepted. Transferred Mac sources, dependencies, results, archive and runner are removed. The local baseline worktree and source-staging scratch are removed. The final report worktree is removed after the PR opens. Shared caches and other lanes' resources are preserved.
