# Shared resources across terminals (X1, study E2)

Status: decided. Date: 2026-10-27. Plan: [next steps](reference-study-2026-10/next-steps.md) item X1; brief: the study's E2.

## Decision

| Step                                         | Verdict                                       | Why                                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Pipelines, layouts, sampler per device    | **REJECT**                                    | 32 pipelines become 2, with equal output, but CPU, heap and startup do not move beyond run-order noise on either host. Pipeline creation is not on the per-frame path.                                     |
| 2. One atlas set per font key                | **KEEP** (memory gate), production work below | At 16 terminals atlas textures fall from 20 to 1.25 MiB (−94%) on both hosts, at 32 from 40 to 1.25 MiB; CPU atlas backing at 32 falls from 9.5 to 1.6 MiB. CPU is unchanged. Output identical.            |
| 3. One command encoder per coordinated frame | **REJECT**                                    | CPU unchanged on both hosts (16 terminals −2.9% PC, −2.1% Mac, inside noise); no latency added, but no gain, and one encoder couples every terminal's failure. Breaks one reentrant-ordering browser test. |

The CPU growth with terminal count is presentation, not resources. On the PC at 16 terminals the GPU process uses 47–50% of a core and the renderer 8–10%. A pure-WebGPU probe reproduces that with no terminal code: 16 canvases cost 52% GPU-process CPU, 16 command buffers merged into one encoder cost the same 52%, and the same 16 tiles drawn into **one shared canvas cost 9%**, the cost of one terminal. None of steps 1–3 can reach that; a shared surface can on Linux. On the Mac the curve is flatter (44% at 16 terminals) and one canvas saves only 16% of GPU-process CPU. That is the next experiment ([below](#next-shared-surface)).

## Method

- Hosts. PC: i7-14700K, RTX 3060 Ti, NVIDIA 615.78.08, Linux, headed Chromium 153.0.8010.12 on native Wayland; WebGPU adapter `nvidia`/`ampere`, `fallback: false`. Mac: M1 MacBook Air on AC, same Chromium, Metal adapter. The PC ran through the shared quiet runner with VRAM ≥ 2 GiB checked before each browser; the Mac under the agent lock. Mac timings had background load around 1–1.5 and are experimental. All numbers are experimental diagnostics, not qualified speedup claims.
- Harness: the baseline packet's archived harness (`.internal/benchmarks/baseline-2026-10/harness.patch.gz`), extended to read shared pipelines and texture identity so a shared atlas is counted once. Production-default ownership (`BENCH_DEFAULT_GPU=1`: shared device, queue and frame coordinator), WebGPU, `burst-output` (the baseline's rolling logs), DPR 2, 13 px.
- Matrix: 80×24 at 1, 4, 16 and 32 terminals and 200×50 at 4, 300 paced updates after 30 warmup updates (5 s windows, five times the study's 1 s, so CPU resolution is 0.2 points), two repetitions, before/after order reversed in the second.
- Pairs are cumulative and same-session: step 1 against main; step 3 against step 1; step 2 against PR #16 (F3, demand-sized atlas) plus steps 1 and 3, because step 2 shares the atlas F3 reshapes.
- Equal output: per-terminal text hashes match in every record, delivered bytes and submitted frames match, and all 30 PC before/candidate screenshot pairs are byte-identical (Mac: text hashes equal in every record).
- Memory: atlas is logical texel storage from the live GPU textures, deduplicated by texture identity; CPU atlas backing is CDP `backingStorageSize` after GC; heap is post-GC `usedSize`; wasm is linear-memory capacity.

## Results

CPU is percent of one core for all Chrome processes; "GPU" is the GPU process alone. Values are means of the two repetitions.

### Step 1: shared pipelines (main → step 1)

| Host / case  | CPU           | GPU process | Callback p95 ms | Pipelines | Startup ms (rep 1/2) |
| ------------ | ------------- | ----------- | --------------- | --------- | -------------------- |
| PC 80×24×1   | 14.5 → 14.0   | 9.6 → 9.2   | 0.30 → 0.30     | 2 → 2     | 230/149 → 152/147    |
| PC 80×24×4   | 26.2 → 25.7   | 19.9 → 19.6 | 0.60 → 0.50     | 8 → 2     |                      |
| PC 80×24×16  | 56.2 → 54.7   | 47.5 → 46.3 | 1.05 → 1.25     | 32 → 2    | 423/367 → 366/360    |
| PC 80×24×32  | 108.4 → 109.9 | 94.7 → 95.6 | 2.20 → 2.35     | 64 → 2    | 656/579 → 561/568    |
| PC 200×50×4  | 28.5 → 27.2   | 20.4 → 19.5 | 0.95 → 0.90     | 8 → 2     |                      |
| Mac 80×24×16 | 44.4 → 43.9   | 29.0 → 29.0 | 1.60 → 1.75     | 32 → 2    |                      |
| Mac 80×24×32 | 65.8 → 64.0   | 41.5 → 39.9 | 2.25 → 2.55     | 64 → 2    |                      |

The startup differences follow run order, not the arm: the first page in each browser is slow, and the step 3 pair (identical pipeline code in both arms) shows the same 600–700 ms first-run spread. Chromium's pipeline cache already deduplicates identical pipelines.

### Step 3: one encoder (step 1 → step 1 + 3)

| Host / case  | CPU           | GPU process | Callback p95 ms | Submitted   |
| ------------ | ------------- | ----------- | --------------- | ----------- |
| PC 80×24×1   | 12.4 → 13.5   | 8.1 → 8.9   | 0.25 → 0.25     | 300 → 300   |
| PC 80×24×4   | 21.7 → 20.9   | 16.9 → 16.3 | 0.40 → 0.40     | 1200 → 1200 |
| PC 80×24×16  | 58.7 → 57.0   | 48.8 → 47.9 | 1.25 → 1.25     | 4800 → 4800 |
| PC 80×24×32  | 114.9 → 114.7 | 97.5 → 98.1 | 2.65 → 2.55     | 9600 → 9600 |
| PC 200×50×4  | 30.5 → 29.6   | 21.4 → 21.1 | 0.95 → 0.95     | 1200 → 1200 |
| Mac 80×24×16 | 44.9 → 43.9   | 27.3 → 28.8 | 1.90 → 1.80     | 4800 → 4800 |
| Mac 80×24×32 | 64.4 → 62.0   | 39.7 → 38.7 | 2.50 → 2.40     | 9600 → 9600 |

The busiest-terminal latency gate holds (callback p95 is flat), so the step is rejected on cost, not latency. The coordinator already submits every terminal's command buffer in one `queue.submit`; merging encoders removes only per-terminal `createCommandEncoder`/`finish`, which is not where the time goes. Against it: one invalid pass invalidates every terminal's frame, and the prototype fails three existing renderer browser tests. Two only count command buffers per submission (expected for this change); "submits an encoded surface before a reentrant font change resizes and configures its canvas" times out, a real reentrancy regression that was not investigated further.

### Step 2: shared atlas per font key (F3 + steps 1, 3 → + step 2)

| Host / case  | CPU           | Atlas textures MiB | CPU atlas backing MiB | Heap MiB    | Callback p95 ms |
| ------------ | ------------- | ------------------ | --------------------- | ----------- | --------------- |
| PC 80×24×1   | 9.8 → 9.7     | 1.25 → 1.25        | 1.59 → 1.60           | 3.27 → 3.28 | 0.20 → 0.20     |
| PC 80×24×4   | 22.6 → 24.0   | 5.0 → 1.25         | 2.36 → 1.60           | 4.03 → 4.01 | 0.45 → 0.50     |
| PC 80×24×16  | 60.6 → 60.6   | 20.0 → 1.25        | 5.42 → 1.60           | 5.52 → 5.39 | 1.35 → 1.30     |
| PC 80×24×32  | 109.4 → 106.5 | 40.0 → 1.25        | 9.49 → 1.60           | 7.39 → 7.12 | 2.20 → 1.65     |
| PC 200×50×4  | 22.4 → 22.3   | 5.0 → 1.25         | 2.36 → 1.60           | 4.03 → 4.01 | 0.65 → 0.70     |
| Mac 80×24×4  | 37.2 → 36.1   | 5.0 → 1.25         | 2.36 → 1.60           | 4.05 → 4.04 | 1.35 → 1.25     |
| Mac 80×24×16 | 46.1 → 45.7   | 20.0 → 1.25        | 5.42 → 1.60           | 5.55 → 5.42 | 1.85 → 1.80     |
| Mac 80×24×32 | 64.4 → 61.8   | 40.0 → 1.25        | 9.50 → 1.60           | 7.41 → 7.14 | 2.55 → 2.50     |
| Mac 200×50×4 | 46.0 → 45.4   | 5.0 → 1.25         | 2.36 → 1.60           | 4.05 → 4.04 | 1.50 → 1.65     |

Atlas memory meets the keep gate (≥50% less at 16 terminals) on both hosts: one ASCII atlas set serves every terminal with the same fitted font, so the cost stops scaling with terminal count. Before F3 the same sharing would remove 300 of 320 MiB at 16 terminals; after F3 it removes 18.75 of 20 MiB. The absolute saving after F3 is small (≈19 MiB GPU and ≈4 MiB CPU at 16 terminals, ≈39 + 8 MiB at 32) and grows with glyph diversity, CJK and emoji, where F3 grows each terminal's atlas separately. CPU does not move: a warm atlas costs nothing per frame. A second terminal with an already-used font skips rasterizing its glyphs, which this matrix does not measure.

### Probe: per-canvas presentation (PC)

`bench/x1/surface-probe.ts` on the research branch draws 1,920 instanced quads per terminal tile (1280×768 device pixels) for 300 frames, three ways, in ABBA order: N canvases with one encoder each and one combined submit (what the coordinator does today), N canvases recorded into one encoder, and one canvas holding all N tiles in one pass.

| Tiles | N canvases GPU % | One encoder GPU % | One canvas GPU % | Renderer % (N canvases → one canvas) |
| ----- | ---------------- | ----------------- | ---------------- | ------------------------------------ |
| 1     | 9.2              | 8.8               | 8.9              | 2.4 → 2.5                            |
| 4     | 18.4             | 18.1              | 9.0              | 2.6 → 2.4                            |
| 16    | 52.2             | 52.0              | 9.0              | 4.1 → 2.4                            |
| 32    | 89.2             | 87.7              | 8.0              | 4.8 → 1.8                            |

The probe's 16-canvas GPU cost (52%) matches the terminal benchmark's (47–50%), so the terminal's own per-frame work is not the GPU-process cost. On the Mac the same probe gives 34.3 / 33.5 / 28.7% at 16 tiles and 43.1 / 42.8 / 37.5% at 32: Core Animation presents separate canvases cheaply, and one large canvas adds its own GPU-process cost. The shared-surface win is large on Linux (−83% at 16) and small on macOS (−16%).

## Correctness qualification (step 2)

Browser tests on the prototype branch (`src/render/tests/shared-atlas.browser.test.ts`, SwiftShader, correctness only):

- Two terminals with an equal font bind the same textures and paint pixel-identical frames.
- A font change on one terminal moves only that terminal to another atlas; it paints exactly what a terminal opened with that font paints, its peer keeps painting the original pixels, and switching back rejoins the shared set.
- When one terminal clears the shared atlas, its peer rebuilds from its own eviction queue on its next frame and paints identical pixels.
- Device loss on one terminal restores it on a replacement device with its own texture set, filled from the retained CPU pages, while its peer keeps the original device; disposing the peer then destroys the original device.
- Atlas unit test: a peer's visible page survives another owner's pressure, every eviction reaches every owner's queue once, and a full atlas defers instead of recycling a pinned page.

The existing renderer suite passes except "coalesces a runtime font change into one full repaint", which expects per-terminal atlas-miss counters; shared counters are not per terminal (production item 4). The other failures come from step 3.

An earlier cut flushed peers' pending frames before every shared-atlas upload. The existing test "captures peer text snapshots before a callback updates that peer's native state" caught that: the flush runs a peer's frame callbacks inside another terminal's draw, and a write made there was acknowledged by the wrong frame. The kept design has no mid-frame flush.

## Production steps for step 2

Not shipped from this experiment: it depends on F3 (#16), and the items below change public metrics and atlas ownership.

1. **Font key.** Key by what the rasterizer reads: family stack, size, weight/bold weight, style, letter spacing, DPR, device cell and character geometry and baseline (wraithterm adds font bytes, fallbacks, line height and features). The prototype uses `JSON.stringify` of the fitted font.
2. **Owner-aware atlas** (`src/render/shared/atlas/atlas.ts`). Each owner keeps the pins from its last frame until its next one. Recycling only takes pages no owner pins. Compaction only touches pages pinned by the current owner alone, because moving a peer's glyphs corrupts its pending or presented frame. Each attached owner has its own eviction queue, consumed at the start of its next build (the cross-owner form of xterm.js's per-renderer layout version, study lane 05). Clear and font-wide invalidation reach every owner the same way.
3. **Texture lifetime** (`src/render/webgpu/gpu-textures.ts`). A grown texture can still be bound by peers' frames pending in the same coordinated frame. Retire it after the coordinated frame submits; the prototype uses `setTimeout(0)`, production should hook the frame coordinator's flush. Each device has its own refcounted texture set; a new device is filled from the CPU pages. Each owner re-binds its glyph bind group when the texture version for its device changes.
4. **Metrics.** `atlasCacheHits`, `atlasCacheMisses`, `atlasEvictions`, `atlasPages` and atlas upload counters become per-owner counts kept in the registration path, not reads of shared atlas totals.
5. **Pressure policy.** A shared atlas reaches F3's 16-layer cap with the union of every terminal's visible set. Decide whether the cap scales with owners or stays fixed with deferral, and test thrash: two terminals whose visible sets together exceed capacity must not rebuild each other every frame.
6. **WebGL2.** One context per terminal cannot share textures, so WebGL2 could share only the CPU atlas and rasterizer, with per-context upload cursors. Measure that separately; the GPU saving is WebGPU-only.
7. **Tests to add.** Cross-owner compaction refusal, growth while a peer's frame is pending under the coordinator, thrash under shared pressure, and dispose of the last owner releasing all device texture sets.

## Next: shared surface

The probe points at a shared presentation surface (one canvas or one swap chain behind several terminals), as in wraithterm's `feat/fleet-surface` (study lane 03). Before building it, measure what the probe skipped: copying or compositing the tiles into each terminal's DOM position (one overlay canvas positioned over terminals versus per-terminal `copyExternalImageToTexture` or `transferToImageBitmap`), clipping and z-order inside scrolling containers, opacity, and resize. Gate: the 16-terminal GPU-process CPU falls by at least 30% with identical screenshots and no added input latency. Its natural home is the terminal-pool work (E6), which already groups terminals.

## Evidence

- Prototype branches: `research/shared-resources` (harness, steps 1 and 3, probe) and `research/shared-resources-step2` (F3 + steps 1, 3 and 2, with the tests above).
- Raw records, frozen bundles, screenshots, logs, `summarize.py` and the run scripts: `/work/reports/ghostty-webgpu-next-2026-10/x1/` (Mac results under `mac/`). `python3 summarize.py <pair-directory>` reprints every table row.
- Source SHAs:
