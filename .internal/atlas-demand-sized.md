# Demand-sized atlases

F3 of the 2026-10 reference-study plan. Baseline `d2ed8989a`.

## Residency

Each GPU texture kind starts with one 512×512 layer. It grows geometrically up to the CPU atlas's existing limit of 16 layers per kind. WebGPU copies existing layers before replacing its texture views and glyph bind groups. WebGL2 copies layers through a read framebuffer. Fixed page dimensions keep the normalized UV coordinates in native records valid. Existing glyph coordinates and generations survive growth. The grayscale and color arrays grow independently.

A registration sweep pins the glyphs present in retained native records, then pins each newly inserted glyph. It first fills existing pages, then allocates a page, then recycles an unpinned page. If every page has visible glyphs, it can compact one page around its pinned glyphs. Compaction commits only if the retained glyphs and the new glyph fit. A failed attempt leaves the old page untouched.

Recycling or compaction increments that page's generation. Native invalidation clears only descriptors with that kind and layer whose generation is old. It changes each affected descriptor's registration counter, so clean rows also rebuild when their glyph coordinates change. That invalidation remains active through missing-glyph retries. Native keys remain allocated until bounded collection can prove that neither cached input cells nor rendered cells reference them.

When the visible set cannot fit, the extra glyph is a blank native descriptor marked as deferred. It cannot point into a reused slot. A later frame retries deferred descriptors when visible pins release reclaimable space. This avoids a clear-and-rebuild loop. The native terminal still retains all input text.

Device and context recovery create fresh small textures, then use the retained CPU pages to restore their required layer counts and pixels. Font changes and explicit atlas clears still invalidate the whole atlas.

## Correctness evidence

The raw receipts and rerunnable harness live in `/work/reports/ghostty-webgpu-next-2026-10/f3-atlas/`.

- Baseline `failing-pressure.log` records three failures. Eviction changes a clean visible glyph's generation, and a visible set beyond capacity never reaches a renderable frame.
- Baseline `failing-growth.log` observes 16 initial layers where the new test requires one.
- `failing-clean-retry.log` captures a blank clean row when page invalidation ends before the registered-glyph retry. `clean-retry.log` records the fix.
- Native tests exercise clean and rotating row storage, descriptor collection during 131 evictions, deferred glyph recovery, and external eviction of a clean row.
- Browser tests read back both texture kinds after growth, preserve clean-row pixels during eviction, compact fragmented pages, and restore pixels after growing to four layers and losing the device or WebGL context.

## Measurement procedure

`run-hardware.sh` runs the existing renderer benchmark with the study's archived L7a diagnostic patches. The local harness patch adds candidate-root selection, records actual texture layer counts for WebGL2, traces full-build calls and atlas resets, and adds italic overhanging glyphs to the cold-cache Unicode fixture. Glyph churn uses the original workload. Both arms use identical input, geometry, text checks, and screenshot capture.

The stage cohort has 450 delivered updates per sample, ten warmup steps, two repetitions, and both GPU backends. Source order and backend order reverse in the second repetition. The allocation cohorts use 80×24 terminals, at counts 1 and 16 for both backends and 32 for WebGPU. Each cohort closes its browser before the next opens. The PC heavy runner holds the quiet reservation and the script checks for at least 2 GiB free VRAM before each browser.

Texture bytes are logical allocated texel storage calculated from live hardware texture dimensions and formats. They exclude driver overhead and are not a resident-VRAM measurement. Timings are experimental. `summarize.py` checks equal delivered bytes, terminal text hashes, submitted frames, and final pixels before reporting the paired results.

## PC results

Host `pc`, Omarchy Linux x86_64, Intel i7-14700K, NVIDIA RTX 3060 Ti, driver 615.78.08, headed Chromium 153.0.8010.12. WebGPU reports vendor `nvidia`, architecture `ampere`, and `fallback: false`. WebGL2 reports ANGLE on the NVIDIA OpenGL driver. Both use DPR 2 and the production default device ownership path. The measured runtime commits are `d2ed8989a745f016188e0a2e749009b3e1450f33` and `069ee7de993d9b87f86372d1950a6497e83e7f45`. Later commits add tests, the generated provenance receipt, and this report. They also remove an unused registration helper that was already absent from the frozen benchmark bundle.

Actual allocated texture storage for the ASCII allocation cohorts is consistent across both repetitions:

| Backend | Terminals | Before, MiB | After, MiB |
| ------- | --------: | ----------: | ---------: |
| WebGPU  |         1 |          20 |       1.25 |
| WebGPU  |        16 |         320 |         20 |
| WebGPU  |        32 |         640 |         40 |
| WebGL2  |         1 |          20 |       1.25 |
| WebGL2  |        16 |         320 |         20 |

That is 93.75% less allocated atlas storage. After the glyph-churn cohort, each candidate atlas has grown to 16 grayscale layers and one color layer, totaling 5 MiB, compared with 20 MiB before.

Every one of the 18 paired screenshots has zero changed pixels. Delivered bytes, native terminal text hashes, and submitted-frame counts also match. The cold-cache fixture includes wide characters, combining marks, italic overhangs, and color emoji. Its screenshots were inspected at their original resolution.

Each 450-update glyph-churn sample has two full rebuild frames before and zero after, on both backends. The candidate recycles 15 individual pages. Glyph registration requests fall from 13,156 to 10,800 per sample. The removed requests were cache hits; the uncached raster work remains.

Stage costs below are the mean inclusive milliseconds per delivered update across the two samples. Each cell shows before → after. These are CPU timings, without a GPU completion or presentation claim.

| Backend | Workload    |  Native frame | Glyph rasterizer |    Atlas sync | Instance upload |
| ------- | ----------- | ------------: | ---------------: | ------------: | --------------: |
| WebGPU  | Glyph churn | 0.481 → 0.452 |    6.381 → 6.548 | 0.034 → 0.028 |   0.341 → 0.344 |
| WebGPU  | Cold cache  | 0.625 → 0.671 |    4.360 → 4.784 | 0.286 → 0.313 |   0.346 → 0.359 |
| WebGL2  | Glyph churn | 0.766 → 0.722 |    6.309 → 6.430 | 0.022 → 0.043 |   0.149 → 0.154 |
| WebGL2  | Cold cache  | 0.626 → 0.600 |    4.307 → 4.286 | 0.100 → 0.106 |   0.144 → 0.146 |

The measured CPU costs increased. These experimental pairs do not establish a speedup or a repeatability envelope:

| Backend | Workload    | All-Chromium CPU, % of one core | Renderer CPU, ms/update | GPU-process CPU, ms/update |
| ------- | ----------- | ------------------------------: | ----------------------: | -------------------------: |
| WebGPU  | Glyph churn |                   65.58 → 67.62 |          9.800 → 10.033 |              1.956 → 1.944 |
| WebGPU  | Cold cache  |                   56.13 → 59.54 |           8.156 → 8.600 |              2.011 → 2.211 |
| WebGL2  | Glyph churn |                   61.19 → 62.70 |           9.622 → 9.811 |              1.211 → 1.178 |
| WebGL2  | Cold cache  |                   48.19 → 49.53 |           7.422 → 7.456 |              1.167 → 1.400 |

Cold-cache WebGPU callback p95 is 7.3 and 8.0 ms before, versus 8.5 and 11.9 ms after. The trace attributes most of the added stage time to glyph rasterization. This two-sample run does not establish its cause. The memory reduction and removal of whole-atlas recovery are directly observed; timing regressions remain visible for review.

## Final verification

`run-gates.sh` records the full build, typecheck, lint, formatting, and unit checks. Vitest passes 1,113 tests with one existing skip, the benchmark tests pass 482 tests, and the checkpoint tests pass four tests.

The broad browser run passes 206 tests with two software-adapter skips and one stale call-count assertion. The assertion expected collection to discard a visible glyph. `run-final-browser.sh` updates that expectation and passes all 28 tests in the affected file, giving 207 passing software-browser tests across the combined runs. Its focused native, atlas, and provenance rerun passes 127 tests.

The same final script runs the grown-atlas WebGPU device-loss and WebGL context-loss tests in headed hardware Chromium. Both tests pass, with 6,795 MiB free VRAM checked before launch. The official full WASM build reproduces both measured binary hashes. Site docs and formatting checks pass.

The worker stops after opening the PR. Independent review, CI, and merge belong to the wave coordinator.
