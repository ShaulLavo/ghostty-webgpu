# 002. Keep the instanced WebGPU renderer and drop the compute-copy renderer

Status: accepted
Date: 2026-10-24 (recorded after the fact; the experiment finished earlier)

## Context

The WebGPU renderer draws one instance per cell and glyph. A compute-based renderer was the obvious next idea. It composes dirty pixel bands into an owned texture, then copies that texture into each new canvas texture. It skips the fullscreen presentation draw. Zutty uses a compute renderer for terminals, and the experiment followed its approach with changes for glyphs that overhang their cell.

An early prototype was rejected on RAF-paced CPU measurements and an isolated GPU timestamp fixture. Neither could settle overall speed, so the experiment was rerun with an optimized implementation and end-to-end endpoints.

## Decision

Keep the instanced renderer. Leave the compute-copy code on its research branch (`de6128e940729e4fb6eb278e9dde3212f36bc4aa` in Fregat) and ship none of it.

## Alternatives considered

- **Compute-copy renderer.** It lost the final comparison on one Apple M1 in headed Chromium 156, with a 200 × 50 terminal at DPR 2 and four balanced paired cohorts against instanced rendering.
  - Completed-update capacity: instanced rendering won all 12 pairs, with paired reductions of 22.58% (interactive), 55.77% (dense), and 66.83% (scroll) for compute-copy. Dense and scroll exceeded the same-build repeatability envelope.
  - Observed-output latency: dense p95 rose 7.49% against an upper repeatability bound of 5.57%. The p50 values stayed inside the envelope.
- **Fullscreen fragment pass.** It was a control, not a candidate. It stays on the research branch with the portable compute control.

## Consequences

- WebGPU keeps one draw path. The Zig frame builder writes cell and glyph records and the renderer uploads changed byte ranges.
- The result is one machine, one browser build, and one workload set. It rejects this implementation. It does not prove that no compute design could win.
- The raw packets were local to the owner's host and are not in the repository. The benchmark repairs from this work shipped, so the benchmark state wrapper in the comparison harness (`bun run bench:compare`) now forwards native frame-builder creation and the snapshot version.
