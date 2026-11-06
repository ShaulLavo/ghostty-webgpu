# Compact-record reopening screen

Status: Approved investigation executed on November 6, 2026. The scientific reopening condition is not established. No layout candidate was built.

The measured runtime is release 0.3.32 at `5dc81e804a7f728a27ba6d6a8fd8b30026cc9caf`. The supplied worktree was fast-forwarded from its clean initial state. Record layout, bridge, shaders, text passes, and the renderer benchmark driver have no audit-to-release drift.

The PC screen used the existing renderer benchmark entry on headed hardware WebGPU and WebGL2. Plain and instrumented arms used the same ownership, font, 200 by 50 grid, DPR 2, and 32 updates. Dense-redraw, sparse-edit, and sustained-scroll passed exact decoded-pixel, text, byte, acknowledgement, and submission equivalence. This is an instrumentation control, not evidence of a faster record representation.

Dense-redraw uploaded 7,500 bytes per update despite 1,600,000 bytes of allocated records. It changes the sequence digits rather than every cell's appearance. The final glyph stream had 9,300 populated slots out of 10,000. Neither the allocation size nor a claim that all glyphs form a sparse overflow stream justifies implementation. Bridge-build timing still includes native row traversal, comparison, and glyph-index work. It does not isolate record packing.

Original M3 worker-ownership and plasma-painting confounds remain unresolved. No new Wraith comparison ran. Any future worker comparison must use our worker entry. No Mac performance acquisition or acceptance matrix ran.

The full report and small runnable acquisition probes are retained at `/work/reports/wave-20261106/audits2/ghostty-webgpu/005-continuation.md` and its adjacent `005-tool` and `005-evidence` directories. The audit coordinator owns them until design review or closure. The source checkpoint adds only this note and the rerunnable analyzer below.

```sh
bun .internal/compact-record-reopening/analyze.ts \
  /work/reports/wave-20261106/audits2/ghostty-webgpu/005-evidence/baseline.json \
  /work/tmp/compact-record-summary.json
```

The analyzer verifies six own-control pairs and five deliberately corrupted negative controls. Its output is diagnostic. It never qualifies performance or changes the original gate.

A compact-layout design and independent review remain mandatory before any candidate. Eventual acceptance still requires at least 20% less dense-redraw CPU, no sparse or scroll regression, and the original dense, NTCharts, plasma, sparse, scroll, grid, terminal-count, DPR, host, and both-backend matrix. Mac WebGL2 remains required and unqualified, not silently removed.
