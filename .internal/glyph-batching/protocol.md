# X2 experiment protocol

Status: Approved. The gate is at least 40% less glyph-raster time with identical atlas pixels. Idle ASCII warmup must not delay first content.

The experiment uses the existing `bench:renderer` runner with a diagnostic patch. Each cohort has three same-session pairs in AB, BA, AB order, both backends, one 200×50 terminal, and DPR 1 or 2. Each arm has eight warmup updates and 64 measured updates. The runner closes its browser between DPR cohorts. Use the shared PC quiet queue and Mac lock described in the wave brief.

`glyph-churn` is the existing benchmark workload. Every update introduces 24 CJK glyphs with combining and color glyphs. `cold-cache` invalidates both atlas and bitmap cache before each update, then writes 50 lines containing ASCII, italic overhangs, CJK, combining marks and emoji. This avoids calling atlas-only eviction a cold font-cache workload. It measures cold glyph/atlas caches with warm browser font resources, not a cold browser installation or font download.

The prototype preserves the full native glyph index. It packs white and black color-detection probes into padded regions on one canvas. Each region has an independent clip and integer translation. One readback covers each chunk up to 8192 pixels wide. Edge contact retries through the control rasterizer. Color brush variants retain their full foreground key and use the control recoloring path.

The warmup-only diagnostic schedules printable ASCII in all four weight/italic combinations after the first content callback, one further animation frame, and an idle callback. It warms bitmap caches, not atlas residency. This is a separate cohort. It must record a start time after first content in every arm where it runs. It is not a production lifecycle implementation.

Raster timings wrap the outermost `rasterize` or `rasterizeBatch` call. Nested per-glyph cache hits are excluded from double counting. Parsing, bridge building, acknowledgement and frame counters use the existing runner. Final atlas page bytes use SHA-256. Canvas screenshots use SHA-256 of the PNG bytes. Browser tests compare the actual bitmap bytes and placement metadata, including intrinsic white, black, gray and currentColor layers.

The first-frame endpoint is the first content-bearing `onFrame` callback, not GPU completion or physical presentation. Record parsed writes, submitted frames, observer callbacks and acknowledgements separately. Matched presentation-event counts remain unresolved by this runner and must not be inferred from screenshots or callbacks. This limitation prevents a production qualification but does not rescue a rejected raster-time gate.

The decision compares the median per-pair raster-time ratio per host, DPR, backend and workload. Do not pool the PC and Mac or treat screenshot success as timing evidence. `analyze.mjs` checks the equal-work counters and prints the decision table.
