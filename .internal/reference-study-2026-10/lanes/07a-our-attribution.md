# L7a: our pipeline attribution

Status: partial. Main stage/scaling diagnostics and WebGL worker/extra-workload diagnostics completed. Later WebGPU completion/worker/presentation work is blocked by host GPU resources. Experimental diagnostics, not headline claims or a cross-machine comparison.

## Scope and provenance

- Runtime source is `ShaulLavo/ghostty-webgpu@26d389150d36341f4ae7e444f47d5614ceeff088`. All instrumentation stays in `/work/reports/ghostty-webgpu-reference-study-2026-10-27/wt/L7a`, with no push. Raw results and runnable inputs live in `../bench/L7a/`. [measured: `bench/L7a/*json`, `sourceArtifacts`]
- PC, i7-14700K, RTX 3060 Ti, NVIDIA 615.78.08; headed pinned Playwright Chromium 153.0.8010.12, native Wayland, default ANGLE OpenGL for WebGL2. WebGPU reports NVIDIA Ampere and `fallback:false`. Host reservation was clear and observed GPU utilization was 0% at admission. The Mac was reachable, on AC and unreserved, but its load averages were 12.17/16.98/18.55, so it was not selected. These observations do not certify constant clocks or compositor idleness. [measured: `bench/L7a/{availability-before,gpu-before,mac-before}.txt`, `smoke.json`, `default-gpu-stages.json`]
- Existing `bench:renderer` is the primary runner. Its built-in workload and frame pacing are retained; `ComparisonTracing` adds synchronous stage spans. The extended runner adds DOM, missing workload cases, grid/count controls, memory snapshots and separate completion endpoints. Existing comparison fixtures supply Unicode, and L6's captured byte chunks will be replayed separately. [src ShaulLavo/ghostty-webgpu@26d3891 scripts/renderer-benchmark.ts:1; bench/renderer-benchmark-entry.ts:1; bench/comparison-tracing.ts:34]
- Every performance window takes `/work/tmp/quiet-turn.sh`. `heavy-jobs.json` retains `jobsDuringRun`. The broad `stages.json` matrix overlaps the persistent `comfy-gallery` server plus three short light jobs: `pr274-final-package-workflow`, `ghw-l6-pty-repeat`, and `ghw-l6-opentui-repeat`. It is diagnostic evidence with disclosed noise. The targeted production-default and scaling windows so far overlap only the pre-existing gallery server. [measured: `bench/L7a/heavy-jobs.json`]

## What each endpoint means

- Parse is the exact `ghostty_terminal_vt_write` call. The public/core write also encodes/copies input and notifies scheduling; it is not the parse-only number. [src ShaulLavo/ghostty-webgpu@26d3891 bench/comparison-tracing.ts:130; src/core/memory.ts:47]
- Bridge build is `bridge_build_frame`, inclusive of the upstream core getters it calls. It is not all time in wasm, and its time cannot be added to its enclosing JS `buildFrame`/`build` inclusive times. Tables use exclusive `self` times to avoid that double-count. [src ShaulLavo/ghostty-webgpu@26d3891 src/core/zig-frame.ts:158; bench/comparison-tracing.ts:93]
- Upload bytes count API buffer lengths and atlas pixel extents. They are not PCIe traffic, driver copy counts, resident GPU memory, or GPU execution time. [src ShaulLavo/ghostty-webgpu@26d3891 src/render/webgpu/text-pass.ts:347; src/render/webgpu/gpu-textures.ts:109]
- Encode/submit is CPU API work. `onSubmittedWorkDone` and polled WebGL fences are separate completion diagnostics. Neither is display presentation. Main callback duration, paced-rAF interval and Chrome presentation feedback must remain separate. [src ShaulLavo/ghostty-webgpu@26d3891 src/render/webgpu/text-pass.ts:213; scripts/comparison-latency.mjs:5]
- Heap is CDP `Runtime.getHeapUsage` after forced GC. Linear wasm memory pages are observed capacity, not live allocations. Core and bridge import one memory per runtime, so they must not be counted twice. GPU atlas/buffer numbers estimate allocation payloads, excluding canvas swapchain, driver bookkeeping and alignment. [src ShaulLavo/ghostty-webgpu@26d3891 src/core/runtime.ts:110; src/core/bridge.ts:129; measured: `bench/L7a/scale-*.json`]

## Architectural checks that change interpretation

1. The stock renderer factory supplies an explicit per-terminal WebGPU device. Production defaults instead share device owner and frame coordinator in the main realm. `default-gpu-stages.json` and scaling select that default path; `stages.json` preserves the stock factory path. Do not read the stock factory's device count as production behavior. [src ShaulLavo/ghostty-webgpu@26d3891 bench/renderer-factory.ts:56; src/render/webgpu/renderer.ts:132; src/render/webgpu/renderer.ts:205; .internal/benchmarks/webgpu-ownership.md:3]
2. Main TerminalSession creation owns a new runtime unless explicitly given a borrowed runtime. Worker actors own their runtime in a separate realm. Our count scaling deliberately uses one owned runtime per terminal, matching default creation, rather than the comparison entry's manually shared runtime. [src ShaulLavo/ghostty-webgpu@26d3891 src/term/session.ts:909; src/worker/runtime.ts:126]
3. The measured runtime uses 64-byte cell and 96-byte glyph GPU records. `docs/benchmark-tracing.md` still describes an 80-byte private glyph layout; that statement is stale for this revision. This lane does not silently reinterpret historical packets. [src ShaulLavo/ghostty-webgpu@26d3891 src/render/shared/instances/layout.ts:1; src/render/webgpu/text-pass.ts:123; docs/benchmark-tracing.md:3; measured: `bench/L7a/scale-200x50-1.json`, 640000 + 960000 byte buffers]
4. WebGPU supports stable physical rows; WebGL2's frame options omit `stableRows`. WebGL2 rebuilds/uploads much more data for viewport scrolling in these fixtures. WebGL2 can skip its draw when no buffer ranges change; WebGPU's submission policy differs. [src ShaulLavo/ghostty-webgpu@26d3891 src/render/webgpu/renderer.ts:506; src/render/webgl/renderer.ts:402; src/render/webgl/renderer.ts:424; measured: `bench/L7a/default-gpu-stages.json`]
5. Native frame construction is not a universal zero-copy path. Input bytes are copied into wasm, the bridge owns canonical output records and cached records, and GPU APIs copy changed ranges out. Some scroll permutations copy cached cell/glyph arrays inside wasm. [src ShaulLavo/ghostty-webgpu@26d3891 src/core/memory.ts:47; scripts/bridge.zig:232; scripts/bridge.zig:377; src/render/webgpu/text-pass.ts:354]

## Measurements and their limits

All numbers below are experimental diagnostics. Earlier windows used fresh pages in one headed browser. Final WebGL controls and L6 replay reuse one window and navigate between cases. That change limits extra compositor surfaces under the observed VRAM pressure. Do not combine these windows into one speed comparison. Primary windows use two 60-update repetitions, 10 warmup updates, 200×50, DPR 2 and 13 px monospace. Scaling uses one 60-update repetition, except 32-terminal WebGPU uses 40 updates. [measured: `protocol.md`, `stages.json`, `default-gpu-stages.json`, `scale-*.json`]

The browser clock is quantized at about 0.1 ms in these unisolated pages. Individual zero-duration write/parse samples are below resolution, not proof of zero work. Means below aggregate exclusive spans over 120 updates, but three decimal places are display formatting, not microsecond accuracy. Stage totals cover wrapped synchronous boundaries, not all browser CPU, layout, raster, driver work or GPU execution. [measured: raw span and sample arrays in `stages.json` and `default-gpu-stages.json`]

`fonts.txt` records Fontconfig matches: JetBrainsMono Nerd Font for monospace, Noto Color Emoji for emoji, and Liberation Sans for the Japanese-language query. This does not prove Chrome's per-character fallback choice or CJK coverage. The glyph-churn numbers describe this actual font stack. They make no claim about CJK visual fidelity or another installed CJK font. Hosted API cases explicitly load JetBrains Mono from `@fontsource/jetbrains-mono@5.3.0`. [measured: `fonts.txt`, result `info.font`; src ShaulLavo/ghostty-webgpu@26d3891 package.json:183]

### GPU stages

Mean milliseconds per requested update. `JS+damage` adds remaining JS, builder option work and damage tracking. `API issue` is CPU command encoding/submission. It is not GPU time. The six common workload rows use the production-default GPU packet; remaining rows use the broader stock-factory diagnostic packet. File selection is explicit in `stage-costs.csv`. [measured: `stage-costs.csv`, derived by `analyze.py`]

| Renderer / workload       | VT parse | Bridge wasm | State/snapshot | Glyph raster | JS+damage | Upload CPU | API issue |
| ------------------------- | -------- | ----------- | -------------- | ------------ | --------- | ---------- | --------- |
| webgl2 / cursor-movement  | 0.001    | 0.010       | 0.012          | 0.000        | 0.053     | 0.013      | 0.019     |
| webgpu / cursor-movement  | 0.003    | 0.016       | 0.014          | 0.000        | 0.063     | 0.031      | 0.033     |
| webgl2 / burst-output     | 0.013    | 0.154       | 0.022          | 0.000        | 0.075     | 0.112      | 0.018     |
| webgpu / burst-output     | 0.009    | 0.070       | 0.018          | 0.000        | 0.069     | 0.023      | 0.022     |
| webgl2 / sustained-scroll | 0.000    | 0.215       | 0.014          | 0.000        | 0.047     | 0.088      | 0.013     |
| webgpu / sustained-scroll | 0.000    | 0.043       | 0.025          | 0.000        | 0.063     | 0.018      | 0.028     |
| webgl2 / glyph-churn      | 0.021    | 0.573       | 0.050          | 5.849        | 0.208     | 0.133      | 0.009     |
| webgpu / glyph-churn      | 0.023    | 0.404       | 0.051          | 5.943        | 0.230     | 0.344      | 0.018     |
| webgl2 / sparse-edit      | 0.001    | 0.008       | 0.004          | 0.000        | 0.049     | 0.013      | 0.015     |
| webgpu / sparse-edit      | 0.001    | 0.008       | 0.012          | 0.000        | 0.077     | 0.026      | 0.029     |
| webgl2 / dense-redraw     | 0.022    | 0.590       | 0.015          | 0.000        | 0.070     | 0.083      | 0.015     |
| webgpu / dense-redraw     | 0.018    | 0.564       | 0.007          | 0.000        | 0.069     | 0.187      | 0.023     |
| webgl2 / warm-unicode     | 0.019    | 0.168       | 0.022          | 0.000        | 0.048     | 0.003      | 0.001     |
| webgpu / warm-unicode     | 0.023    | 0.052       | 0.038          | 0.000        | 0.074     | 0.029      | 0.031     |
| webgl2 / cold-cache       | 0.033    | 0.581       | 0.046          | 3.882        | 0.224     | 0.274      | 0.020     |
| webgpu / cold-cache       | 0.024    | 0.596       | 0.032          | 3.982        | 0.265     | 0.615      | 0.032     |
| webgl2 / resize-dpr       | 0.000    | 1.626       | 0.033          | 2.737        | 2.413     | 0.333      | 0.025     |
| webgpu / resize-dpr       | 0.000    | 1.586       | 0.033          | 2.673        | 1.167     | 0.068      | 0.000     |
| webgl2 / hidden-output    | 0.010    | 0.000       | 0.000          | 0.000        | 0.019     | 0.000      | 0.000     |
| webgpu / hidden-output    | 0.011    | 0.000       | 0.000          | 0.000        | 0.020     | 0.000      | 0.000     |

The log fixture writes 10 lines, about 2 KB, per update. Dense redraw replaces every visible row with roughly 10 KB of plain text. Sparse edits move the cursor and replace one character. Glyph churn introduces 24 new CJK codepoints per update with combining text and emoji. Cold-cache explicitly clears the atlas and rasterizer before every update. Warm Unicode repeats a fixed mixed-language/emoji corpus. Resize/DPR alternates grid dimensions and fitted-font pixel ratio 1/2; browser `devicePixelRatio` stays 2. This is renderer invalidation stress, not a real monitor transition. [src ShaulLavo/ghostty-webgpu@26d3891 bench/renderer-benchmark-entry.ts:181; measured: `instrumentation.patch`, raw `info` and write arrays]

### Canvas2D and DOM stages

Mean milliseconds per update. Canvas2D's browser text drawing is inside API issue. DOM's retained-node mutation is inside JS+damage. A zero explicit bridge-builder column does not mean no wasm state reads. The existing DOM tracer's old `replaceWith` hook does not cover the current retained Text-node writes, so its separate command column is unavailable. Browser layout/paint remain outside these stage spans. [measured: `stage-costs.csv`; src ShaulLavo/ghostty-webgpu@26d3891 bench/comparison-tracing.ts:341; src/render/dom/renderer.ts:108]

| Renderer / workload         | VT parse | State/snapshot | JS+damage | Canvas API issue |
| --------------------------- | -------- | -------------- | --------- | ---------------- |
| dom / cursor-movement       | 0.002    | 0.047          | 0.185     | unavailable      |
| canvas2d / cursor-movement  | 0.002    | 0.043          | 0.071     | 0.195            |
| dom / burst-output          | 0.021    | 0.281          | 0.531     | unavailable      |
| canvas2d / burst-output     | 0.009    | 0.257          | 0.541     | 0.901            |
| dom / sustained-scroll      | 0.000    | 0.264          | 0.498     | unavailable      |
| canvas2d / sustained-scroll | 0.000    | 0.273          | 0.507     | 0.203            |
| dom / glyph-churn           | 0.026    | 0.415          | 1.864     | unavailable      |
| canvas2d / glyph-churn      | 0.032    | 0.437          | 0.863     | 1.129            |
| dom / sparse-edit           | 0.004    | 0.039          | 0.213     | unavailable      |
| canvas2d / sparse-edit      | 0.001    | 0.052          | 0.071     | 0.207            |
| dom / dense-redraw          | 0.013    | 0.276          | 0.570     | unavailable      |
| canvas2d / dense-redraw     | 0.023    | 0.258          | 0.543     | 3.807            |
| dom / warm-unicode          | 0.027    | 0.294          | 1.098     | unavailable      |
| canvas2d / warm-unicode     | 0.022    | 0.303          | 0.902     | 0.125            |
| dom / cold-cache            | 0.030    | 0.322          | 1.123     | unavailable      |
| canvas2d / cold-cache       | 0.027    | 0.298          | 0.877     | 0.838            |
| dom / resize-dpr            | 0.000    | 0.536          | 1.337     | unavailable      |
| canvas2d / resize-dpr       | 0.000    | 0.469          | 0.943     | 8.838            |
| dom / hidden-output         | 0.013    | 0.000          | 0.017     | unavailable      |
| canvas2d / hidden-output    | 0.013    | 0.000          | 0.027     | 0.000            |

### Frame distributions and GPU API uploads

Milliseconds. Callback quantiles pool the two repetitions' 120 callback samples where present. Write p95 measures the synchronous API call, before painting. Buffer bytes and range-call counts are per requested update, not per physical display frame. Range calls omit WebGPU row-control uniform writes; scroll additionally updates 24 row-control bytes on changed-offset frames. Atlas columns count pixel payloads. Actual driver transfers are unknown. [measured: `stage-costs.csv`; src ShaulLavo/ghostty-webgpu@26d3891 src/render/webgpu/text-pass.ts:252]

| Renderer / workload       | Callback p50/p95/p99 | Write p95 | Buffer KiB / range calls | Atlas KiB / calls | Submissions / updates |
| ------------------------- | -------------------- | --------- | ------------------------ | ----------------- | --------------------- |
| webgl2 / cursor-movement  | 0.10 / 0.20 / 0.20   | 0.10      | 42.61 / 2.00             | 0.00 / 0.00       | 120 / 120             |
| webgpu / cursor-movement  | 0.10 / 0.30 / 0.30   | 0.10      | 42.61 / 2.00             | 0.00 / 0.00       | 120 / 120             |
| webgl2 / burst-output     | 0.30 / 0.60 / 0.70   | 0.10      | 900.10 / 1.00            | 0.00 / 0.00       | 120 / 120             |
| webgpu / burst-output     | 0.20 / 0.40 / 0.40   | 0.10      | 38.54 / 13.00            | 0.00 / 0.00       | 120 / 120             |
| webgl2 / sustained-scroll | 0.40 / 0.70 / 0.80   | 0.00      | 918.85 / 1.00            | 0.00 / 0.00       | 120 / 120             |
| webgpu / sustained-scroll | 0.20 / 0.30 / 0.40   | 0.00      | 0.12 / 1.00              | 0.00 / 0.00       | 120 / 120             |
| webgl2 / glyph-churn      | 6.40 / 8.90 / 12.20  | 0.10      | 1562.50 / 2.00           | 27.71 / 1.42      | 120 / 120             |
| webgpu / glyph-churn      | 6.80 / 7.70 / 9.90   | 0.10      | 1562.52 / 2.00           | 27.71 / 1.42      | 120 / 120             |
| webgl2 / sparse-edit      | 0.10 / 0.20 / 0.20   | 0.10      | 43.86 / 2.00             | 0.00 / 0.00       | 120 / 120             |
| webgpu / sparse-edit      | 0.10 / 0.30 / 0.40   | 0.10      | 43.86 / 2.00             | 0.00 / 0.00       | 120 / 120             |
| webgl2 / dense-redraw     | 0.70 / 1.20 / 1.20   | 0.20      | 937.41 / 1.00            | 0.00 / 0.00       | 120 / 120             |
| webgpu / dense-redraw     | 0.80 / 1.00 / 1.10   | 0.10      | 937.41 / 1.00            | 0.00 / 0.00       | 120 / 120             |
| webgl2 / warm-unicode     | 0.20 / 0.40 / 0.40   | 0.10      | 4.66 / 0.05              | 0.00 / 0.00       | 6 / 120               |
| webgpu / warm-unicode     | 0.20 / 0.40 / 0.50   | 0.10      | 9.09 / 4.05              | 0.00 / 0.00       | 120 / 120             |
| webgl2 / cold-cache       | 4.80 / 7.00 / 7.70   | 0.10      | 1562.50 / 2.00           | 1280.00 / 2.00    | 120 / 120             |
| webgpu / cold-cache       | 5.10 / 7.90 / 9.50   | 0.10      | 1562.52 / 2.00           | 1280.00 / 2.00    | 120 / 120             |
| webgl2 / resize-dpr       | 4.50 / 7.00 / 8.80   | 0.00      | 3164.22 / 4.00           | 256.00 / 1.00     | 240 / 120             |
| webgpu / resize-dpr       | 4.80 / 6.60 / 8.00   | 0.00      | 3164.22 / 4.00           | 256.00 / 1.00     | 240 / 120             |
| webgl2 / hidden-output    | 0.00 / 0.00 / 0.00   | 0.10      | 0.00 / 0.00              | 0.00 / 0.00       | 0 / 120               |
| webgpu / hidden-output    | 0.00 / 0.00 / 0.00   | 0.10      | 0.00 / 0.00              | 0.00 / 0.00       | 0 / 120               |

The sparse edit uploads about 44.9 KB despite changing one character because old/new cursor rows and coalesced row ranges participate. Scroll reuse is much narrower in WebGPU: 120 buffer bytes per requested scroll versus about 940,906 in WebGL2. Lower upload bytes do not establish lower total CPU or GPU time. Both GPU renderers still draw viewport-sized instance populations when they submit. [measured: `stage-costs.csv`; src ShaulLavo/ghostty-webgpu@26d3891 src/render/webgpu/text-pass.ts:237; src/render/webgl/renderer.ts:419]

### L6 captured workloads

One 64-update pass per corpus, 8 warmup updates, 100×30, DPR 2, WebGL2, one reused headed window. Each `repetition` selects a different corpus, so six repetitions are not six repeats of one workload. Warmup replays the first eight chunks before the measured sequence. Inputs are decoded and split outside timing, then written with the original chunk boundaries. Byte and fixture hashes are in L6's metadata. This window occurred after the GPU resource block and cannot validate normal-load GPU latency. [measured: `L6-gl-final.json`, `run-L6-gl-final.sh`, `../workloads/*.json`]

| Corpus              | VT parse ms | Bridge ms | Raster ms | JS+damage ms | Upload / issue ms | Buffer KiB | Write / callback p95 ms |
| ------------------- | ----------- | --------- | --------- | ------------ | ----------------- | ---------- | ----------------------- |
| opentui-plasma      | 0.834       | 0.248     | 0.000     | 0.242        | 0.039 / 0.006     | 459.3      | 1.80 / 0.60             |
| ntcharts-heatmap    | 0.336       | 0.273     | 0.000     | 0.128        | 0.038 / 0.009     | 187.3      | 0.70 / 0.60             |
| sparse-edits        | 0.006       | 0.013     | 0.086     | 0.052        | 0.019 / 0.020     | 59.5       | 0.10 / 0.50             |
| sustained-logs      | 0.014       | 0.084     | 0.000     | 0.067        | 0.052 / 0.019     | 270.4      | 0.10 / 0.30             |
| synchronized-frames | 0.055       | 0.275     | 0.000     | 0.083        | 0.067 / 0.014     | 468.8      | 0.20 / 0.60             |
| unicode-varied      | 0.027       | 0.094     | 0.000     | 0.058        | 0.048 / 0.016     | 266.2      | 0.10 / 0.30             |

OpenTUI plasma sends 7,306,231 bytes over the 64 updates, about 114 KB per update. Here parse time exceeds bridge time. The API write p95 is 1.8 ms while renderer callback p95 is 0.6 ms because parsing happens before the scheduled render callback. This is why callback-only numbers are insufficient for ANSI-heavy TUI output. [measured: `L6-gl-final.json`, `L6-stage-costs.csv`]

## Scaling and memory

Browser CPU is percent of one core, summed across browser processes. Heap is post-GC CDP `usedSize` and excludes separately reported linear wasm memory. GPU atlas figures are descriptor payload estimates, not measured VRAM residency. Each backing canvas keeps its requested grid/DPR; CSS scales multiple canvases into the visible mosaic. The harness counts one input chunk before fan-out, so total input bytes equal `writtenBytes × terminalCount`. [measured: `scaling.csv`, raw `scale-*.json`; src ShaulLavo/ghostty-webgpu@26d3891 scripts/renderer-benchmark.ts:71]

| Renderer | Grid / count | CPU % | JS heap MiB | Wasm MiB | GPU buffers MiB | Atlas payload MiB | RAF callbacks | Callback p95 ms |
| -------- | ------------ | ----- | ----------- | -------- | --------------- | ----------------- | ------------- | --------------- |
| webgl2   | 200x50 / 1   | 11.8  | 2.86        | 7.75     | 1.53            | 20                | 60            | 0.50            |
| webgpu   | 200x50 / 1   | 13.8  | 2.84        | 7.75     | 1.53            | 20                | 60            | 0.40            |
| webgl2   | 300x80 / 1   | 13.8  | 2.86        | 18.75    | 3.66            | 20                | 60            | 1.20            |
| webgpu   | 300x80 / 1   | 13.8  | 2.84        | 18.75    | 3.66            | 20                | 60            | 0.50            |
| webgl2   | 80x24 / 1    | 8.9   | 2.86        | 3.31     | 0.29            | 20                | 60            | 0.30            |
| webgpu   | 80x24 / 1    | 14.8  | 2.84        | 3.31     | 0.29            | 20                | 60            | 0.30            |
| webgl2   | 80x24 / 16   | 23.6  | 4.93        | 53.00    | 4.69            | 320               | 960           | 0.20            |
| webgpu   | 80x24 / 16   | 57.1  | 4.93        | 53.00    | 4.69            | 320               | 60            | 1.30            |
| webgl2   | 80x24 / 4    | 12.8  | 3.38        | 13.25    | 1.17            | 80                | 240           | 0.20            |
| webgpu   | 80x24 / 4    | 24.6  | 3.40        | 13.25    | 1.17            | 80                | 60            | 0.50            |
| webgpu   | 80x24 / 32   | 113.7 | 7.14        | 106.00   | 9.38            | 640               | 40            | 2.80            |

At 32 WebGL2 terminals the stock browser context limit was reached; a renderer entered `lost`, and the snapshot probe failed while reading the absent text pass. That is an invalid 32-active-terminal performance case, retained in `scale-80x24-32.*`. It is not proof that the public terminal host cannot fall back. The comparison runner explicitly raises the context limit to 32; the renderer runner does not. [measured: `scale-80x24-32.log`; src ShaulLavo/ghostty-webgpu@26d3891 scripts/comparison-runner.mjs:205; src/render/webgl/renderer.ts:315]

Observed ownership at 1/4/16/32 WebGPU terminals is one device, one queue, one coordinator, N scheduler objects and 2N pipelines. There is one coordinated browser callback per update, but N render encodings and N resource sets. At 32 terminals that means 64 pipelines, 106 MiB combined wasm capacity, about 9.38 MiB GPU instance buffers, and 640 MiB estimated atlas payload. WebGL2 has N contexts, N schedulers and 2N programs. The default device/coordinator sharing already works; pooling those again is not the next memory win. [measured: `scaling.csv`, `scale-webgpu-32.json`; src ShaulLavo/ghostty-webgpu@26d3891 .internal/benchmarks/webgpu-ownership.md:5]

The atlas reserves 16 layers of 512×512 pixels for each of grayscale and RGBA, even for the small warm ASCII corpus. That is 512×512×16×(1+4) = 20 MiB per terminal, before canvas textures or driver overhead. JS rasterizer bitmap caches and atlas pixel arrays are additional. Native frame records use 160 bytes per cell, plus missing-glyph lists, masks and native caches. Bridge frame-cache arrays include another cell/glyph record store, and certain permutations copy records within wasm. [src ShaulLavo/ghostty-webgpu@26d3891 src/render/shared/atlas/atlas.ts:29; src/render/webgpu/gpu-textures.ts:31; src/core/zig-frame.ts:59; scripts/bridge.zig:232; scripts/bridge.zig:377]

### Glyph diversity memory

Post-run snapshots. The rasterizer figure is retained bitmap payload/accounting, additional to linear wasm capacity. JS post-GC heap from traced windows is not used here because span records themselves retain JS objects. [measured: `glyph-memory.csv`]

| Workload     | Wasm MiB | Rasterizer entries | Rasterizer bitmap MiB | Native glyph keys |
| ------------ | -------- | ------------------ | --------------------- | ----------------- |
| cold-cache   | 8.75     | 23                 | 0.044                 | 17                |
| resize-dpr   | 7.75     | 23                 | 0.006                 | 23                |
| burst-output | 7.75     | 23                 | 0.006                 | 23                |
| glyph-churn  | 9.56     | 1706               | 1.109                 | 1705              |
| warm-unicode | 8.75     | 44                 | 0.050                 | 38                |

### Scrollback capacity

These are browser-independent core memory measurements under Bun 1.4.4, not timing benchmarks. They use an 80×24 terminal, no renderer and no render state. The explicit experiment removes the byte budget, sets the row budget and writes in 64-line chunks. `processMemory` is preserved raw, but is not used as a JS-heap attribution measure. [measured: `core-history-memory-unbounded-bytes.json`, `bench/renderer-diagnostic-memory.mjs` in `instrumentation.patch`]

| Row budget | Written rows | Retained rows | Wasm pages | Wasm capacity MiB |
| ---------- | ------------ | ------------- | ---------- | ----------------- |
| 0          | 1            | 0             | 23         | 1.44              |
| 10000      | 10000        | 9977          | 122        | 7.62              |
| 50000      | 50000        | 49977         | 543        | 33.94             |

A preliminary line-budget-only probe retained just 1,228 and 848 rows for the 10,000- and 50,000-line requests because it preserved the native byte budget and used one giant write. Those observations are retained in `core-history-memory.json`. They must not be labeled 10K/50K retained-scrollback measurements. Clearing the independent byte budget gives 9,977 and 49,977 retained rows above. The explicit experiment changes both byte policy and write chunking, so it does not isolate which part of the preliminary result was pruning versus batching. [measured: both core-history packets; src ShaulLavo/ghostty-webgpu@26d3891 src/core/terminal.ts:393]

## Idle, cursor blink and background simulation

Two 3-second samples for idle/blink. Hidden-output delivers 120 log chunks across two one-second paced sequences while `renderer.setDocumentVisible(false)` is set. The page remains visible and browser throttling is disabled. This tests renderer suspension, not real background-tab power behavior. Browser CPU includes unrelated browser housekeeping. [measured: `idle-background.csv`, `stages.json`]

| Renderer / state         | Browser CPU % | Render callbacks / second | Submitted frames |
| ------------------------ | ------------- | ------------------------- | ---------------- |
| dom / settled-idle       | 1.50          | 0.00                      | 0                |
| canvas2d / settled-idle  | 0.67          | 0.00                      | 0                |
| webgl2 / settled-idle    | 0.50          | 0.00                      | 0                |
| webgpu / settled-idle    | 0.33          | 0.00                      | 0                |
| dom / cursor-blink       | 0.98          | 1.99                      | 12               |
| canvas2d / cursor-blink  | 0.98          | 1.99                      | 12               |
| webgl2 / cursor-blink    | 1.15          | 1.99                      | 12               |
| webgpu / cursor-blink    | 1.31          | 1.99                      | 12               |
| dom / hidden-output      | 2.45          | 0.00                      | 0                |
| canvas2d / hidden-output | 4.41          | 0.00                      | 0                |
| webgl2 / hidden-output   | 2.94          | 0.00                      | 0                |
| webgpu / hidden-output   | 4.41          | 0.00                      | 0                |

All four renderers schedule no frames while settled idle or explicitly hidden, even while hidden VT writes continue. Blink requests about two callbacks per second after the VT cursor requests blinking and the renderer is focused. Zero render callbacks does not mean zero browser-process CPU. [measured: `idle-background.csv`; src ShaulLavo/ghostty-webgpu@26d3891 src/render/shared/scheduler.ts:147]

## Main-thread and worker API entry

Explicit hardware WebGL2, 200×50, DPR 2, Bench Mono 13 px, accessibility off, owned runtime per terminal. Two 60-update repetitions per workload. The main API arm runs before the worker API arm, so these are observations rather than a balanced causal comparison. Worker text/row publication is real production behavior, not removed for the experiment. Both arms ran under the later VRAM-pressure condition. [measured: `hosted-gl-worker-0.json`, `hosted-gl-worker-1.json`; src ShaulLavo/ghostty-webgpu@26d3891 src/worker/runtime.ts:250]

| Entry / workload      | Browser CPU % | State snapshot ms/update | Other JS ms/update | Draw span p95 ms | Write ack p50/p95 ms | Submissions / updates |
| --------------------- | ------------- | ------------------------ | ------------------ | ---------------- | -------------------- | --------------------- |
| main / burst-output   | 16.8          | 0.033                    | 0.163              | 0.80             | 0.10 / 0.20          | 120 / 120             |
| main / glyph-churn    | 61.4          | 0.066                    | 0.355              | 8.90             | 0.10 / 0.20          | 120 / 120             |
| main / sparse-edit    | 10.6          | 0.016                    | 0.092              | 0.30             | 0.00 / 0.10          | 120 / 120             |
| main / dense-redraw   | 18.3          | 0.022                    | 0.143              | 1.30             | 0.10 / 0.20          | 120 / 120             |
| worker / burst-output | 25.9          | 0.152                    | 0.932              | 1.90             | 2.10 / 2.80          | 119 / 120             |
| worker / glyph-churn  | 78.6          | 0.308                    | 1.166              | 9.70             | 8.90 / 10.20         | 117 / 120             |
| worker / sparse-edit  | 21.2          | 0.033                    | 0.656              | 1.10             | 1.40 / 2.20          | 120 / 120             |
| worker / dense-redraw | 29.3          | 0.155                    | 1.023              | 2.90             | 2.50 / 3.80          | 120 / 120             |

Worker writes coalesce in a few cases: 119/120 log and 117/120 glyph-churn submissions. Thus these arms do not perform exactly equal frame counts, and their CPU ratios cannot establish a speedup or regression. The page-side callback counter is zero in worker cases because the draws happen in the worker's rAF, which is measured by its draw spans. Worker write acknowledgement is neither GPU completion nor presentation. Main-page CDP heap excludes the worker isolate; worker JS heap was not measured. Worker wasm capacity is available in `diagnostics.hosted[0].snapshot`. WebGPU worker creation is blocked by the later device-request failure. [measured: `hosted.csv`, `worker-boundary-diagnostic.log`, `hosted-gl-worker-1.json`]

## Completion, presentation and long tasks

The WebGL completion probe inserts `fenceSync`, flushes and polls `clientWaitSync` with zero timeout. This is a separate pacing experiment. Its wall time includes message/driver scheduling and timer polling. The approximately 4.2 ms floor is polling quantization, not measured GPU execution duration. These probes occurred under the resource-pressure condition. [measured: `completion.csv`, `completion-gl.json`; diagnostic `completion` and `fence` in `instrumentation.patch`]

| Workload     | Fence wall p50/p95/p99 ms | Samples |
| ------------ | ------------------------- | ------- |
| burst-output | 4.20 / 4.30 / 8.20        | 60      |
| glyph-churn  | 4.20 / 8.30 / 28.60       | 60      |
| sparse-edit  | 4.20 / 4.30 / 4.30        | 60      |
| dense-redraw | 4.20 / 8.20 / 8.30        | 60      |

`GPUQueue.onSubmittedWorkDone` instrumentation is preserved, but its new device could not be acquired after the resource block. No WebGPU completion numbers or GPU timestamps are claimed. Timestamp-query support was not enabled on the measured devices; this is not a claim that the adapter lacks that optional feature. [measured: `history-0.log`, `overhead-0-0.log`, raw device features; src ShaulLavo/ghostty-webgpu@26d3891 bench/renderer-factory.ts:56]

Input-to-presented latency is unmeasured. The ordinary comparison bundle was built successfully, and `run-latency.sh` plus `run-latency-gl.sh` preserve the intended existing runner command. It was not run after the resource block. A valid future run must use the comparison runner's command/frame identity join and Chrome `AnimationFrame::Presentation`; callback completion, a second rAF, screenshots and worker write acknowledgements are not substitutes. Physical/optical presentation is outside this study. [measured: `comparison-build.log`; src ShaulLavo/ghostty-webgpu@26d3891 scripts/comparison-latency.mjs:5; scripts/comparison-latency.mjs:30]

Observed main-thread long tasks whose start falls inside a trace window: 0 across 126 traced cases. Startup is excluded. These are observer records, not a complete Chrome task trace or a guarantee about tail delivery. [measured: `long-tasks.csv`, filtered by `finalize-data.py`]

Long-task observer records remain in each terminal diagnostic snapshot. They include startup unless filtered by the trace begin/end markers. Do not read unfiltered counts as measured-workload long tasks. Callback p50/p95/p99 and raw frame-interval samples are retained in the main packets and `stage-costs.csv`. Chrome task-trace attribution and presentation traces were not collected in this lane. [measured: raw `diagnostics.terminals[].longTasks`, trace markers, and frame interval arrays]

## Startup and shipped asset sizes

Startup uses a fresh terminal/page inside an already-running browser. Compile calls can hit Chromium's process cache. They do not measure an uncached network fetch. Core and bridge compile in parallel, so their durations must not be added as serial work. First submission includes font measurement, runtime setup, render initialization, initial 200-line content and scheduling; it is not first presentation. Arms have different browser/cache order, so startup medians do not establish which backend starts faster. [measured: `startup.csv`; src ShaulLavo/ghostty-webgpu@26d3891 src/core/runtime.ts:90]

| Renderer / pages | Core compile p50/p95 ms | Bridge compile p50 ms | Instantiate call p50 ms | First submission p50/p95 ms |
| ---------------- | ----------------------- | --------------------- | ----------------------- | --------------------------- |
| webgl2 / 12      | 1.30 / 8.90             | 0.70                  | 0.20                    | 47.30 / 244.50              |
| webgpu / 12      | 4.10 / 5.90             | 0.50                  | 0.10                    | 103.80 / 127.80             |
| dom / 24         | 1.70 / 5.20             | 0.80                  | 0.20                    | 35.30 / 42.10               |
| canvas2d / 24    | 1.30 / 5.20             | 0.50                  | 0.10                    | 41.60 / 50.50               |

The following JS sizes are standalone Bun 1.4.4 minified browser ESM bundles retaining all exports, not the diagnostic bundle and not a claim about every consumer's import-specific bundle. Worker API and worker entry are separate payloads. WASM bytes are the checked-in pinned artifacts. [measured: `sizes.json`, `bench/renderer-diagnostic-sizes.mjs` in the patch]

| Asset / entry       | Bytes  | Gzip bytes |
| ------------------- | ------ | ---------- |
| ghostty-vt.wasm     | 821390 | 285053     |
| bridge.wasm         | 20910  | 9372       |
| canvas-compose.wasm | 3464   | 1836       |
| src/index.ts        | 438555 | 116368     |
| src/worker/index.ts | 423000 | 109185     |
| src/worker/entry.ts | 241939 | 61665      |

The core artifact records official Ghostty `7b11f3dca034d8d24369ad3856afe57946d7902a`, unpatched, Zig 0.16.0, ReleaseSmall. The bridge imports core memory, rather than owning another heap. Both artifact hashes match the source packet inventories. [src ShaulLavo/ghostty-webgpu@26d3891 ghostty-vt.provenance.json:1; measured: `sizes.json`, packet `sourceArtifacts`]

## Instrumentation overhead and qualification

The WebGL control uses A/B/B/A in one browser with the same compiled bundle: tracing absent, tracing active, tracing active, tracing absent. Two samples per condition are too few for a correction factor. All callbacks, bytes and frame counters are retained. [measured: `overhead-gl-abba.json`, `run-final-gl.sh`]

| Workload     | Control browser CPU % | Traced browser CPU % | Control callback sum ms | Traced callback sum ms |
| ------------ | --------------------- | -------------------- | ----------------------- | ---------------------- |
| burst-output | 9.34                  | 10.10                | 18.05                   | 16.90                  |
| dense-redraw | 11.80                 | 16.36                | 44.20                   | 45.05                  |
| glyph-churn  | 52.08                 | 51.65                | 392.20                  | 366.50                 |

The observed perturbation is not a uniform positive offset: glyph-churn browser CPU is lower in traced samples, while dense CPU is higher. Cache/JIT/driver variation and unwrapped work remain. Do not subtract these differences from the stage tables or multiply traced shares by control CPU to predict a speedup. The WebGPU overhead acquisition was blocked, leaving an explicit gap. [measured: `overhead.csv`, `overhead-0-0.log`]

All heavy-runner records are copied into `heavy-jobs.json`, including exact `jobsDuringRun` and resource cleanup. The broad stage window has the disclosed short light-job overlaps. Later windows generally retain the pre-existing gallery service; consult each record rather than assuming an empty GPU. [measured: `heavy-jobs.json`]

## GPU resource block and remaining work

The initial NVIDIA snapshot showed 1,015 MiB allocated and 0% utilization. Later fresh browsers fail WebGPU device creation. With diagnostic browsers closed, NVIDIA attributes roughly 6.95 GiB to Hyprland, 308 MiB to quickshell, and about 7.8 GiB total on the 8 GiB card. Completed measurement scopes report zero leftover processes. One rejected metadata probe left three processes for the heavy runner to terminate; final host inspection found no task-owned browser. No desktop process, setting or driver was changed. This shows a host resource block; VRAM pressure or driver/device exhaustion is a hypothesis, not a proven root cause. [measured: `gpu-before.txt`, `gpu-blocked.txt`, `gpu-after-hosted.txt`, `gpu-after-final-gl.txt`, `heavy-jobs.json`; hypothesis: cause of device-request failure]

The Mac was checked again, with AC power, no owner reservation and no agent lock, but load around 20–22 on an 8-core M1. It was not a quiet timing candidate. No Mac payload, lock or process was created. [measured: `mac-before.txt`; follow-up fleet availability recorded in the lane conversation]

The last fleet probe shows battery power, load 13.97/11.61/13.17 and recent owner input, so the Mac still fails the quiet/AC prerequisite. [measured: `mac-after.txt`]

Remaining coverage requires a quiet hardware session with GPU capacity: WebGPU completion and timestamps, WebGPU worker entry, balanced main/worker latency, and Chrome presentation/input latency. Real hidden-tab policy, monitor DPR events, worker-isolate JS heap and GPU execution-time attribution also remain open. The existing data answer CPU stage and allocation questions, not those endpoints. [measured: protocol coverage above; hypothesis: a fresh eligible host session resolves the hardware prerequisite]

## Top five measured bottlenecks

1. **Cold glyph work.** Glyph churn spends about 5.94 ms/update in WebGPU rasterization and 5.85 ms in WebGL2, versus roughly 0.02 ms parsing. Callback p95 is 7.7/8.9 ms in that packet. Forced cold-cache cycles remain several milliseconds. The rasterizer/cache/font stack is the first target for diverse or repeatedly invalidated text, subject to the font-coverage limit above. [measured: `stage-costs.csv`; src ShaulLavo/ghostty-webgpu@26d3891 src/render/shared/atlas/zig-glyphs.ts:36]
2. **Dense bridge construction and ANSI-heavy parsing are different costs.** Plain dense text spends far more in bridge work than VT parse; OpenTUI plasma reverses the ordering, with 0.83 ms parse versus 0.25 ms bridge at 100×30. A renderer-only optimization does not remove ANSI parsing from write latency. [measured: `stage-costs.csv`, `L6-stage-costs.csv`]
3. **Fixed per-terminal resource payload.** A small warm terminal reserves a 20 MiB atlas descriptor payload. At 32 terminals, estimated atlases total 640 MiB and combined linear wasm capacity 106 MiB. Sharing the main device/coordinator has not shared atlases, pipelines or owned runtimes. The allocation sizes are measured; actual resident savings from demand-sized/shared resources remain unmeasured. [measured: `scaling.csv`; src ShaulLavo/ghostty-webgpu@26d3891 src/render/shared/atlas/atlas.ts:29]
4. **WebGL2 viewport-scroll record traffic.** About 941 KB/update is uploaded versus 120 bytes in WebGPU for the same requested viewport-scroll sequence. Bridge CPU averages about 0.215 versus 0.043 ms. WebGL2 does not opt into the stable-row path. These API-byte and CPU observations justify a bounded GL row-indirection experiment, not a GPU-throughput win claim. [measured: `default-gpu-stages.json`, `stage-costs.csv`; src ShaulLavo/ghostty-webgpu@26d3891 src/render/webgl/renderer.ts:402]
5. **Per-terminal encode/resource work still scales after callback sharing.** WebGPU has one rAF per update, yet browser CPU is about 14.8/24.6/57.1/113.7% of one core for 1/4/16/32 small terminals in these single diagnostic samples. At 32 it still owns 64 pipelines and encodes 32 terminal frames per update. This identifies remaining duplicated work; it does not isolate driver, GPU or shader time. WebGL2 additionally reaches the stock context limit before a valid 32-active case. [measured: `scaling.csv`, `scale-80x24-32.log`; src ShaulLavo/ghostty-webgpu@26d3891 src/render/shared/frame-coordinator.ts:63]

## What surprised me relative to the concepts page

- Both GPU backends use persistent Zig records, but their scrolling work is very different. The conceptual phrase "upload changed ranges" hides the stable-physical-row optimization selected only by WebGPU. [src ShaulLavo/ghostty-webgpu@26d3891 docs/concepts.md:29; src/render/webgpu/renderer.ts:507; measured: `stage-costs.csv`]
- "One terminal state" is about authority, not one process-wide runtime. Default sessions own independent wasm instances and memory. Core and bridge share memory inside each runtime; terminals can explicitly borrow a runtime. [src ShaulLavo/ghostty-webgpu@26d3891 docs/concepts.md:13; src/term/session.ts:909; measured: `scaling.csv`]
- The main-realm scheduler/device sharing is already shipped, despite historical attribution tables showing independent devices. The current benchmark ownership note is essential reading before repeating those historical conclusions. [src ShaulLavo/ghostty-webgpu@26d3891 .internal/perf-attribution.md:986; .internal/benchmarks/webgpu-ownership.md:3; measured: `scaling.csv`]
- Write completion remains far ahead of display. It can be sub-clock-resolution for small updates while rAF pacing stays near 16.7 ms. Hidden writes advance VT state without frames. Neither callback nor worker acknowledgement can stand in for presentation. [src ShaulLavo/ghostty-webgpu@26d3891 docs/concepts.md:27; measured: `stage-costs.csv`, `idle-background.csv`, `hosted.csv`]
- The 80-byte GPU glyph statement in the tracing document does not describe this revision's 96-byte allocation/upload path. Current allocation counters and historical packets need their own interpretation. [src ShaulLavo/ghostty-webgpu@26d3891 docs/benchmark-tracing.md:3; src/render/shared/instances/layout.ts:4; measured: `scaling.csv`]

## Reproduction, checks and cleanup

`instrumentation.patch` and incremental `instrumentation.bundle` retain the local-only commits. `reproduce.sh` reconstructs the worktree from `26d389150` and demonstrates frozen-browser-bundle replay through the existing renderer runner. Every packet retains the exact browser bundle plus its SHA-256, WASM hashes, browser version, requested launch flags, OS, geometry/font settings and raw samples. L6's final packet additionally records the owned browser process command line. Earlier packets record requested flags rather than expanded Playwright defaults. [measured: packet `sourceArtifacts`, `environment`, `info`; `reproduce.sh`, bundle verification]

Instrumentation evolved during collection, so early source revision labels are the clean runtime base with dirty benchmark files. Frozen browser bundles retain the actual runtime and instrumented hot path for those packets; use `BENCH_PREBUILT_BUNDLE` and, for workers, `BENCH_PREBUILT_WORKER` when replaying. Do not treat different instrumentation revisions as A/B product changes. The final source patch changes no runtime source, package/lockfile or WASM bytes. [measured: `instrumentation.patch`, packet bundle hashes, final `git diff --name-only 26d389150 HEAD -- src '*.wasm' package.json bun.lock`]

The source build and TypeScript checks pass. Diagnostic smoke failures, rejected setup windows and failed WebGPU acquisitions remain labeled in their own logs, rather than being silently removed. `analyze.py` regenerates CSV exports; `write-notes.py` regenerates these tables. [measured: `build.log`, `typecheck-build.log`, `typecheck-final.log`, `typecheck-metadata.log`, smoke/error logs]

Cleanup status and final source identity are recorded in `cleanup.json` and `source.json`. The worktree/dependency directory is temporarily retained because L7b explicitly borrows its pinned `node_modules` through a read-only symlink. It must not be removed until L7b reports done. Requested raw results, source patch/bundle and reproducers remain owned by this study and can be removed when the study archive is no longer needed. No routes, services, containers or permanent deployments were created. [measured: cleanup inventory; explicit L7b dependency-retention instruction in lane conversation]
