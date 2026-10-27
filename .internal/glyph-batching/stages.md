# Measured CPU stages

Write CPU includes the synchronous parse call and notifyWrite. It is not an isolated parser profiler sample. Bridge and acknowledgement are per-update means, summarized by the median across three runs. Raster time is in the experiment decision table. Upload and encode/submit CPU are not separately instrumented in this probe. Their byte/call/frame counters remain in the compact receipts.

| Host | DPR | Backend | Workload    | Write CPU control/batch ms | Bridge control/batch ms | Acknowledge control/batch ms |
| ---- | --- | ------- | ----------- | -------------------------- | ----------------------- | ---------------------------- |
| pc   | 1   | webgl2  | glyph-churn | 0.000 / 0.000              | 0.339 / 0.352           | 0.005 / 0.006                |
| pc   | 1   | webgl2  | cold-cache  | 0.100 / 0.100              | 0.664 / 0.683           | 0.005 / 0.006                |
| pc   | 1   | webgpu  | glyph-churn | 0.000 / 0.000              | 0.277 / 0.270           | 0.003 / 0.003                |
| pc   | 1   | webgpu  | cold-cache  | 0.100 / 0.100              | 0.669 / 0.669           | 0.003 / 0.005                |
| pc   | 2   | webgl2  | glyph-churn | 0.000 / 0.000              | 0.334 / 0.345           | 0.005 / 0.006                |
| pc   | 2   | webgl2  | cold-cache  | 0.100 / 0.100              | 0.680 / 0.686           | 0.005 / 0.005                |
| pc   | 2   | webgpu  | glyph-churn | 0.000 / 0.000              | 0.263 / 0.283           | 0.005 / 0.005                |
| pc   | 2   | webgpu  | cold-cache  | 0.100 / 0.100              | 0.662 / 0.684           | 0.005 / 0.005                |
| mac  | 1   | webgl2  | glyph-churn | 0.000 / 0.000              | 0.488 / 0.575           | 0.002 / 0.003                |
| mac  | 1   | webgl2  | cold-cache  | 0.100 / 0.100              | 1.266 / 1.453           | 0.003 / 0.006                |
| mac  | 1   | webgpu  | glyph-churn | 0.000 / 0.000              | 0.406 / 0.492           | 0.002 / 0.005                |
| mac  | 1   | webgpu  | cold-cache  | 0.100 / 0.100              | 1.133 / 1.255           | 0.005 / 0.005                |
| mac  | 2   | webgl2  | glyph-churn | 0.000 / 0.000              | 0.436 / 0.462           | 0.002 / 0.003                |
| mac  | 2   | webgl2  | cold-cache  | 0.100 / 0.100              | 1.022 / 1.086           | 0.003 / 0.005                |
| mac  | 2   | webgpu  | glyph-churn | 0.000 / 0.000              | 0.364 / 0.381           | 0.003 / 0.003                |
| mac  | 2   | webgpu  | cold-cache  | 0.100 / 0.100              | 0.995 / 1.039           | 0.003 / 0.006                |
