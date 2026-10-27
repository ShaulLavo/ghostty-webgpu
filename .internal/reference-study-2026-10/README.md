# Reference study: 27 terminal projects against ghostty-webgpu

Status: Approved. Date: 2026-10-27. Source: `ghostty-webgpu@26d389150` with core `ghostty-org/ghostty@7b11f3d` (unpatched).

This study compares ghostty-webgpu with 27 browser and native terminal projects. It covers what we do well, where other projects have better ideas, and what to change. It is built from source inspection of every repository, two measurement lanes on real hardware, and one build-feasibility experiment. The lane reports in [`lanes/`](lanes/) carry the file:line evidence; this page carries the decisions.

Evidence labels used below: **[measured]** means a number from a run in this study; **[src]** means the claim is read from source at the recorded revision; **[hypothesis]** means a judgement not yet tested. All measurements are experimental diagnostics, not headline claims (see [Benchmarks](#benchmarks)).

## Executive assessment

**Keep the architecture's spine.** The unpatched Ghostty core, the separate Zig bridge that shares the core's memory, retained per-cell records with changed-range uploads, the paged glyph atlas, and the renderer fallback chain are better than what any reference ships. No reference beats our incremental text delivery: coder/ghostty-web re-exports the viewport row by row, NimbleMarkets uploads the whole grid on every paint, Rio re-uploads whole instance buffers, Restty rebuilds full viewport geometry and yetty uploads every visible row. Only alleneubank (dirty rows) and wraithterm (row map plus changed rows) are in the same class. [src, lanes 02–04]

Our parser path is also the fastest measured: 510 MiB/s on ASCII against Restty 334, xterm.js 143 and coder 101, and 630 against 349, 123 and 106 on log output. SGR-heavy input narrows the gap to 117 / 109 / 102 / 66. [measured, lane 07b] Every competitor that reads deeper into Ghostty than the public C API (coder, NimbleMarkets, anomalyco, wraithterm, Restty, zem, terax) carries a Ghostty patch or private internals. Our unpatched baseline costs us nothing measurable today. [src, lanes 02–04]

**Fix these first, in order:**

1. **Synchronized output (DEC 2026) was not honored.** Two lanes found it independently and a real-WASM probe confirmed it. Fixed in [PR #6](https://github.com/ShaulLavo/ghostty-webgpu/pull/6). [src + measured, lanes 01, 05]
2. **WebGPU does fixed work on frames that change nothing.** It always acquires a canvas texture, clears and redraws the full viewport, and submits, even when the frame uploaded zero bytes (`src/render/webgpu/renderer.ts:520-528`). WebGL2 skips the draw in that case (`src/render/webgl/renderer.ts:424`). On one 80×24 terminal our WebGPU used 14–15% of a core where our WebGL2 used 3–4% on repeated output, and 16% against 12% on rolling logs. [src + measured, lane 07b]
3. **Glyph rasterization is where time goes when text varies.** On a glyph-churn workload, rasterization takes about 5.9 ms per update, against 0.02 ms of parsing and 0.4–0.6 ms of frame building. [measured, lane 07a] We also draw box, block, braille and powerline characters from the font, where xterm.js, wraithterm, NimbleMarkets and anomalyco draw them procedurally. [src, lanes 02, 03, 05]
4. **Many terminals scale poorly.** WebGPU used 15%, 25%, 57% and 114% of a core for 1, 4, 16 and 32 small terminals. Each terminal reserves a 20 MiB glyph atlas (640 MiB at 32), two pipelines and its own WASM runtime. The device, queue and frame callback are already shared; what remains per terminal is resources and one render encoding each. [measured, lane 07a] How much of the CPU growth those explain is untested (E2). [hypothesis]
5. **WebGL2 scrolling uploads about 941 KB per update where WebGPU uploads 120 bytes.** WebGL2 never enables the stable-row path WebGPU uses. [measured, lane 07a]

**Leave alone:** the unpatched core and separate bridge (ADR 001), the instanced renderer over compute-copy (ADR 002), the paged atlas with per-page eviction (better than wraithterm's, Rio's and beamterm's), the JS-free native frame builder, and Canvas per-glyph painting (word-run replay already failed on contextual alternates). [src, lane 01 §9]

## Reference inventory

Revisions are the inspected default-branch heads in [`references-manifest.tsv`](references-manifest.tsv). Clones live in `/work/projects/references/web-terminals/<owner>__<repo>`.

| Repository                     | Revision                      | Role                                                           | Core / rendering                                                                                        | Depth and notable gaps                                                                                                                        |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| coder/ghostty-web              | `1858a59`                     | Our migration baseline; complete browser terminal              | Patched Ghostty with a custom 16-byte cell API; Canvas2D only                                           | Deep (lane 02). Benchmarked at 0.4.0; crashes on the 13th ZWJ-heavy write                                                                     |
| NimbleMarkets/ghostty-web      | `ce4116a` + 7 branches        | Fork with WebGPU/WebGL/Canvas backends, Kitty graphics, BiDi   | Modern C API with a small Kitty-enabling patch; per-cell JS extraction, full-grid uploads               | Deep on `nm-webgpu`, `nm-kitty-meow`, `kitty-shared-memory`, `nm-rtl`, `osc-7501`. `nm-webgpu` built (611 KiB core); WebGPU benchmark blocked |
| anomalyco/ghostty-web          | `6e24d04` + 8 branches        | Fork; Canvas2D with native Ghostty procedural sprites          | Custom patch exposing font internals                                                                    | Deep on sprites (lane 02, lane 08)                                                                                                            |
| rcarmo/ghostty-web             | `b4daeeb`                     | Fork integrating alleneubank WebGL plus post-process shaders   | NimbleMarkets-style adapter; forces full uploads                                                        | Medium                                                                                                                                        |
| diyism/ghostty-web-for-brow6el | `63e1e46`                     | Fork; headless/browser split                                   | Carries GPU files but constructs Canvas2D                                                               | Short entry                                                                                                                                   |
| alleneubank/ghostty-webgl      | `6828f79`                     | WebGL renderer package with an embedded patched terminal       | Dirty-row 32-byte records, bearing-aware dual atlases, three passes                                     | Medium                                                                                                                                        |
| coder/ghostty-web #155, #162   | read 2026-10-27               | WebGL feature request; NimbleMarkets PR                        | Both open and unmerged; #162 still patches Ghostty                                                      | Complete                                                                                                                                      |
| wiedymi/restty                 | `3db45b0`                     | Complete browser terminal                                      | Ghostty fork plus TypeScript font engine (text-shaper), WebGPU/WebGL2, full-viewport rebuild            | Deep (lane 03); benchmarked, geometry confounded                                                                                              |
| junkdog/beamterm               | `7cde649`                     | Renderer only (Rust/wasm, WebGL2)                              | 8-byte cells, one draw, Canvas glyphs; needs an external parser                                         | Deep; renderer-only benchmark run                                                                                                             |
| betterclever/wraithterm        | `1151069` + 35 branches       | Complete browser terminal plus an xterm.js-compatible wrapper  | Patched Ghostty linked into Rust wasm; harfrust+swash fonts; 20-byte WebGPU cells; row map; worker pool | Deep, including `feat/fleet-surface`, `perf/input-latency`, `perf/worker-socket`. Benchmark blocked by GPU device creation                    |
| tobilg/gespenst                | `0ce1633`                     | Browser terminal                                               | Canvas text runs over GPU backgrounds                                                                   | Medium                                                                                                                                        |
| zokrezyl/yetty                 | `0fad103` + 18 branches       | Native-first C terminal/app framework with a web build         | libvterm, MSDF glyphs, fullscreen fragment cell lookup, uploads every row                               | Deep on algorithm; no benchmark (no small adapter). BSL 1.1 licence                                                                           |
| raphamorim/rio                 | `ec9ca50`                     | Native GPU terminal (Rust, wgpu) with a headless `librio-wasm` | Own VT; Sugarloaf renderer; run shaping (CoreText/swash)                                                | Deep (lane 04). No maintained complete browser app at HEAD                                                                                    |
| iCodeIN/rio-terminal           | `4862d4d`                     | Exact 2023 snapshot of Rio                                     | —                                                                                                       | Short; nothing unique                                                                                                                         |
| zem-sh/terminal                | `416ab54`                     | Complete browser terminal                                      | Patched Ghostty internals, run shaping; WebGL fallback renders nothing (no-op tick)                     | Medium                                                                                                                                        |
| userland-run/terminal          | `22abb55`                     | NanoVM-specific web app                                        | NanoVM's own grid                                                                                       | Short                                                                                                                                         |
| omnidotdev/terminal            | `f1bd5fd`                     | Native plus monolithic browser Rio derivative                  | Own simple Rust VT grid                                                                                 | Short; disposal only clears DOM                                                                                                               |
| ensky0/tildaz                  | `f9d1fc8`                     | Native Ghostty app (Windows)                                   | Skyline atlas growth, stable font IDs                                                                   | Short                                                                                                                                         |
| crynta/terax-ai                | `640e8b2`                     | Tauri/React product                                            | Restty-derived custom core; per-terminal WASM memory reclamation, SIMD/scalar packaging                 | Medium                                                                                                                                        |
| austindelic/blackhole          | `e67dee1`                     | Not a terminal                                                 | —                                                                                                       | Short                                                                                                                                         |
| vibecook-dev/ghosttea          | `3eee581`                     | Electron product                                               | Native libghostty plus its own binary-frame render worker                                               | Medium                                                                                                                                        |
| NimbleMarkets/go-booba         | `073c560`                     | Go/Bubble Tea host for browser WASM and native PTYs            | Drives a ghostty-web terminal; copies strings and polls every 16 ms                                     | Medium (lane 06)                                                                                                                              |
| NimbleMarkets/ntcharts         | `bed05cf` (`v2`)              | Chart TUI library; workload producer                           | `v2` already contains `picture` and `v2-booba`                                                          | Medium; real heatmap capture produced                                                                                                         |
| rbbydotdev/opentui-web         | `483099b`                     | OpenTUI in the browser                                         | Direct Canvas/WebGL/WebGPU painters that bypass VT parsing                                              | Medium; plasma capture produced                                                                                                               |
| indexzero/opentui-web          | `483099b`                     | Same default HEAD as rbbydotdev                                | Useful painter fixes on side branches                                                                   | Short                                                                                                                                         |
| dynamite-bud/v86               | `f153daf`                     | v86 fork running native Ghostty in an emulated Linux guest     | Guest GL to browser WebGPU; xterm serial path writes one byte at a time                                 | Short; a workload, not a renderer                                                                                                             |
| xtermjs/xterm.js               | `991857a` (6.0.0 = `f447274`) | Upstream baseline                                              | JS parser; WebGL addon with procedural glyphs, write buffer, visibility pause                           | Deep (lane 05); benchmarked                                                                                                                   |
| ghostty-org/ghostty            | `68640f3` (pin `7b11f3d`)     | Upstream                                                       | Native renderer, font stack, lib-vt C API                                                               | Deep (lane 05); sprite build experiment (lane 08)                                                                                             |

## Source-backed comparison

Each row names the best idea found, who has it, and what it means for us. Lane notes carry the file:line citations.

| Area                        | Where we stand                                                                                                                                                                                                                                  | Best ideas elsewhere                                                                                                                                                                                                                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core and bridge             | Two WASM modules share one `WebAssembly.Memory`; the bridge calls the public C API inside WASM. No full-buffer copy between modules. Upstream HEAD adds no API that would replace the bridge.                                                   | wraithterm links Ghostty and Rust into one module; coder and NimbleMarkets expose patched or per-cell APIs.                                                                                                                                                                        | **Keep.** Ours is coarser-grained than per-cell JS getters and needs no patch. A pin bump needs Zig 0.17 and brings wide-cell selection and resize fixes; take it for correctness, not speed. (lanes 01, 02, 05)                                                                                                                                                      |
| Frame construction          | Persistent 64-byte cell + 96-byte glyph records; row identity; unchanged-cell reuse. Seams: O(R²) row matching, 2R+D+3 JS→core acknowledge calls per frame although a native clean call exists, overupload of clean gaps between distant edits. | wraithterm: 20-byte cells, versioned rows, general row map with owned slots. NimbleMarkets/alleneubank: 32-byte cells. beamterm: 8 bytes. Rio: 4-byte backgrounds + 32-byte glyphs.                                                                                                | **Keep the model, fix the seams, test a compact layout.** Smaller records are not yet shown to matter: after reuse our uploads are small, and lane 07b shows record size does not predict end-to-end CPU. They do halve memory and dense-redraw uploads. (lanes 01, 03, 04)                                                                                           |
| GPU                         | One instanced pass, six vertices per cell for backgrounds and glyphs, full-viewport redraw every submitted frame, linear atlas sampling.                                                                                                        | wraithterm indexes cell storage in the vertex shader with flat varyings and degenerates blank quads; Rio uses a fullscreen background triangle and 4-vertex glyph strips and `textureLoad`; yetty does fragment cell lookup.                                                       | **Experiment, don't replace.** ADR 002's compute-copy loss stands; fragment lookup was only a control there. Cheapest wins are skipping no-change frames and degenerate blank glyph quads. (lanes 03, 04)                                                                                                                                                             |
| Dirty tracking and scroll   | WebGPU: physical row rotation (single glyph batch only). WebGL2: no stable rows, so scroll re-uploads the viewport.                                                                                                                             | wraithterm's general row map handles partial-region scroll and insert/delete lines, not just rotation.                                                                                                                                                                             | **Port row indirection to WebGL2 first;** consider a general row map when partial-region scroll is measured. (lanes 03, 07a)                                                                                                                                                                                                                                          |
| Fonts and glyphs            | Browser Canvas `fillText` per cell or grapheme; readback; full-key glyph index; 16 × 512² layers per kind per terminal; no run shaping; no procedural sprites.                                                                                  | xterm.js, wraithterm, NimbleMarkets, indexzero: procedural box/block/braille. anomalyco: native Ghostty sprites through a patch. wraithterm: harfrust+swash in WASM with explicit fonts. Rio and zem: run shaping. beamterm: batched Canvas raster. tildaz: growing skyline atlas. | **Add procedural sprites in TypeScript, batch cold rasterization, size atlases on demand.** Native Ghostty sprites need an upstream change (lane 08). Run shaping is the largest feature gap, but it's a capability, not a speed fix. Rio's hash-only shaping cache and beamterm's slot reuse without invalidation are hazards our full keys avoid. (lanes 02–05, 08) |
| Scheduling                  | RAF coalescing, opt-in immediate presentation, document-visibility pause, focus-gated blink. Missing: DEC 2026 (fixed in #6), per-terminal visibility, write time-slicing and backpressure.                                                     | xterm.js: IntersectionObserver pause, 12 ms write budget, synchronized-output escape timer. wraithterm: microtask-coalesced writes, 8 MiB queue limit, adaptive idle-immediate rendering (`perf/input-latency`).                                                                   | **Add per-terminal visibility and an opt-in batched write API.** Keep synchronous `write`. (lanes 03, 05)                                                                                                                                                                                                                                                             |
| Workers and many terminals  | Main realm shares device, queue and frame callback; atlases, pipelines, runtimes are per terminal. Workers: one worker, runtime and device per terminal; each published frame is a full structured clone.                                       | wraithterm `feat/fleet-surface`: one surface, shared pipelines, atlases keyed by font bytes, size and features, shared per worker pool. wraithterm main: pooled workers share a WASM instance and device. ghosttea: binary frames.                                                 | **Biggest structural opportunity.** Share atlases and pipelines across terminals with the same font key; let one worker host many terminals; send compact binary frame deltas. (lanes 01, 03, 04, 07a)                                                                                                                                                                |
| Memory and startup          | 821 KB core + 21 KB bridge WASM (285 + 9 KB gzip); main bundle 439 KB minified. 7.75 MiB WASM capacity for a 200×50 terminal; 20 MiB atlas reserved per terminal.                                                                               | wraithterm engine is 2.7 MiB; terax reclaims per-terminal WASM memory and budgets scrollback.                                                                                                                                                                                      | **Our startup is lean; our steady footprint per terminal isn't.** Demand-sized atlases are the largest single saving. (lanes 03, 04, 07a)                                                                                                                                                                                                                             |
| Correctness and quality     | 167/169 conformance (both failures reproduce upstream). DEC 2026 was missing. No BiDi; no run shaping.                                                                                                                                          | NimbleMarkets BiDi maps visual and logical columns through paint, cursor, selection, links and mouse.                                                                                                                                                                              | **BiDi deserves its own correctness prototype**, separate from any renderer. (lane 02)                                                                                                                                                                                                                                                                                |
| Reliability and maintenance | Device-loss restore, WebGL context recovery, fallback chain, unpatched pin.                                                                                                                                                                     | wraithterm's old renderers keep reporting a lost device; zem's WebGL fallback is a no-op; Omni needed a `wasm-opt` workaround.                                                                                                                                                     | **We're ahead.** Keep qualifying the integrated backend (painted output), not just source presence. (lane 04)                                                                                                                                                                                                                                                         |

### What "closer to native" means here

These are five separate things, and we have one of them:

- **VT core:** yes, unpatched upstream lib-vt.
- **Procedural sprites:** no. Upstream's sprite face can't be compiled from unpatched source into a library build: `global.io()` hits a deliberate compile error in `global.zig`, and the font package pulls in eight more WASM build errors at the pin (lane 08). anomalyco gets it through a patch against an older upstream that predates the guard.
- **Shaping:** no. Native uses HarfBuzz or CoreText through the codepoint resolver; platform font discovery doesn't port, and HarfBuzz alone doesn't solve fallback or rasterization (lane 05).
- **Rasterization:** no. We use browser Canvas; wraithterm uses swash with supplied fonts.
- **Render code:** no. Upstream's renderer is Metal/OpenGL with a native thread model. The portable parts are record layout, glyph placement and blending rules, not code (lane 05).

### What "zero-copy" means here

Nothing in this space is zero-copy, including us. Input bytes are copied into WASM; the bridge writes records into WASM memory that JS views without copying; `writeBuffer` copies changed ranges to the GPU; cold glyphs are read back from a canvas. wraithterm transfers input buffers to its worker (avoiding a structured clone) and still copies into WASM. NimbleMarkets' Kitty shared-memory path still copies pixels twice. (lanes 01, 02, 06)

## Benchmarks

### Method

- **Host:** PC, i7-14700K, RTX 3060 Ti, Arch Linux, Hyprland. Headed Chromium 153 on the hardware adapter, verified at runtime. The M1 Mac had load 14–22 throughout and failed the quiet-host prerequisite.
- **Scheduling:** runs went through the heavy-job runner. Light jobs could overlap, and every overlap is recorded in `heavy-jobs.json`.
- **Matched settings:** cols/rows, font file, size, DPR, input chunks and scrollback, per workload. Text output was checked equal after every run; the NTCharts heatmap was also checked at the pixel level.
- **Repetitions:** four counterbalanced runs per cell in the cross-project matrix; two in our stage attribution.
- **Raw data:** packets, adapters and reproducers are archived at `/work/reports/ghostty-webgpu-reference-study-2026-10-27/` (224 MiB): `bench/L7a/reproduce.sh`, `bench/L7b/`, workloads in `bench/workloads/`, and adapter commits as patches in `patches/`.
- **Blocked:** halfway through, new browsers could no longer create a WebGPU device (`vkCreateDevice ... VK_ERROR_INITIALIZATION_FAILED`). Hyprland held 6.96 GiB of the card's 8 GiB. That blocked wraithterm, NimbleMarkets WebGPU, GPU completion and presentation timing, and the worker entry. VRAM pressure is the likely cause but is unproven.

### Parser throughput (isolated, no rendering) [measured, lane 07b]

16 MiB per fixture, 4 KiB chunks, 100×30, median MiB/s of four runs. Different Ghostty revisions and bindings, so this compares entry pipelines, not parser algorithms.

| Fixture      | ours | Restty | xterm.js 6.0 | coder 0.4 |
| ------------ | ---: | -----: | -----------: | --------: |
| ASCII        |  510 |    334 |          143 |       101 |
| rolling logs |  630 |    349 |          123 |       106 |
| SGR          |  117 |    109 |          102 |        66 |
| cursor       |  206 |    187 |           76 |        74 |

### Paced complete-terminal matrix [measured, lane 07b]

One 80×24 terminal, DPR 2, 120 paced 4 KiB updates, % of one core across Chrome processes (median of four).

| Workload     | ours WebGPU | ours WebGL2 | xterm.js WebGL2 | coder Canvas2D | Restty WebGPU | Restty WebGL2 |
| ------------ | ----------: | ----------: | --------------: | -------------: | ------------: | ------------: |
| ASCII        |        14.3 |         4.1 |            13.7 |           24.1 |          24.8 |          15.7 |
| SGR          |        14.1 |         3.4 |            12.3 |           19.2 |          20.7 |          13.5 |
| cursor       |        15.0 |         2.7 |             9.0 |            9.4 |          16.3 |           9.4 |
| rolling logs |        16.2 |        11.7 |            14.5 |           26.2 |          22.8 |          18.1 |

The repeated fixtures can produce identical viewport records. Our WebGL2 then skips uploads and draws, and our WebGPU doesn't. Rolling logs is the fairer product signal. Restty and coder geometry differed from ours in these runs, so treat their rows as exploratory. A dense NTCharts heatmap at one terminal was within noise between our WebGL2 (17.8%) and xterm.js (16.9%).

### Our own stage costs [measured, lane 07a]

200×50, DPR 2, mean ms per update.

| Workload         | Renderer | Parse | Bridge | Glyph raster | Upload CPU | Encode/submit |
| ---------------- | -------- | ----: | -----: | -----------: | ---------: | ------------: |
| sparse edit      | WebGPU   | 0.001 |  0.008 |            0 |      0.026 |         0.029 |
| sustained scroll | WebGPU   |     0 |  0.043 |            0 |      0.018 |         0.028 |
| sustained scroll | WebGL2   |     0 |  0.215 |            0 |      0.088 |         0.013 |
| dense redraw     | WebGPU   | 0.018 |  0.564 |            0 |      0.187 |         0.023 |
| glyph churn      | WebGPU   | 0.023 |  0.404 |        5.943 |      0.344 |         0.018 |
| cold cache       | WebGPU   | 0.024 |  0.596 |        3.982 |      0.615 |         0.032 |
| resize/DPR       | WebGPU   |     0 |  1.586 |        2.673 |      0.068 |             0 |

A captured OpenTUI plasma stream (escape-heavy) reverses dense text's ordering: 0.83 ms parse against 0.25 ms bridge at 100×30.

### Scaling [measured, lane 07a]

80×24 terminals, one sample each.

| Terminals | WebGPU CPU % |  WebGL2 CPU % | WASM capacity MiB | Atlas reserved MiB | Pipelines (WebGPU) |
| --------: | -----------: | ------------: | ----------------: | -----------------: | -----------------: |
|         1 |         14.8 |           8.9 |               3.3 |                 20 |                  2 |
|         4 |         24.6 |          12.8 |              13.3 |                 80 |                  8 |
|        16 |         57.1 |          23.6 |                53 |                320 |                 32 |
|        32 |        113.7 | context limit |               106 |                640 |                 64 |

### Renderer-only: beamterm [measured, lane 07b]

Both arms drew from our unpatched core with the same bytes in WebGL2. Our dense and scroll frames cost 0.2–0.3 ms CPU against beamterm's 0.8–0.9 ms, almost all in converting cells across its public JS→Rust API. That measures the adapter, not beamterm's GPU design.

### Not measured, and what would resolve it

| Gap                                                       | Why                                                                | Resolving run                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| wraithterm complete-terminal comparison                   | WebGPU device creation failed for every candidate, ours included   | Free VRAM on the PC (or a quiet M1), run the retained native-only smoke, then `wraith-native` vs ours WebGPU/WebGL2 vs xterm.js on the L6 chunks |
| NimbleMarkets `nm-webgpu`                                 | Same                                                               | Same session; its core already builds                                                                                                            |
| GPU completion, presentation and input latency            | Same                                                               | `onSubmittedWorkDone` plus timestamp queries plus the existing presentation endpoint                                                             |
| Whether WebGPU's fixed cost also appears on macOS (Metal) | Mac not quiet                                                      | Experiment E1 on the M1                                                                                                                          |
| Worker entry CPU and heap                                 | WebGPU blocked; worker isolate heap not reachable through CDP here | Same session as above                                                                                                                            |
| Monitor DPR change, real hidden-tab policy                | Needs a physical display change and a real background tab          | Manual headed session                                                                                                                            |
| Energy                                                    | Linux counters here are CPU time, not energy                       | Mac `proc_pid_rusage` method from `docs/benchmarks/mac-m1-2026-10-10`                                                                            |

## Ranked improvement plan

Ranked by expected value times confidence. Effort: S is about a day, M a week, L more.

### Do now (high confidence)

| #   | Change                                                                                                                                                                          | Why                                                                                                                                   | Effort                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Honor DEC 2026 synchronized output                                                                                                                                              | Correctness bug, two lanes plus a WASM probe                                                                                          | S, [PR #6](https://github.com/ShaulLavo/ghostty-webgpu/pull/6) |
| 2   | Skip WebGPU acquire/encode/submit when a frame changes no bytes and no cursor, blink or overlay state                                                                           | Matches WebGL2; an unacquired WebGPU canvas keeps its last image. Lane 07b shows a 3–5× CPU gap on repeated output.                   | S (E1)                                                         |
| 3   | Demand-sized atlas: start each kind at one or two layers and grow                                                                                                               | 20 MiB per terminal is reserved even for ASCII; 640 MiB at 32 terminals                                                               | S–M                                                            |
| 4   | Stable rows (row indirection) for WebGL2                                                                                                                                        | 941 KB vs 120 B per scroll update; bridge CPU 0.215 vs 0.043 ms                                                                       | M (E5)                                                         |
| 5   | Procedural sprites in TypeScript ahead of `fillText` (box, block, braille, sextant, powerline), using Ghostty's draw tables as the reference geometry                           | Font-independent seams; xterm.js, wraithterm, NimbleMarkets and anomalyco all do this; native Ghostty sprites need an upstream change | M (E4)                                                         |
| 6   | Bridge seams: native clean in place of 2R+D+3 acknowledge calls; hash-based row matching in place of O(R²); split upload ranges when the clean gap exceeds a measured threshold | Concrete, local, no API change                                                                                                        | S each                                                         |
| 7   | Per-terminal visibility (IntersectionObserver) feeding the scheduler and the worker visibility message                                                                          | A visible document can hide most panes; parsing continues, painting stops                                                             | S                                                              |

### Do next (substantial refactors, gated by experiments)

| #   | Change                                                                                                                                                                                                                                                                             | Why                                                                                                                                                      | Effort |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 8   | **Shared multi-terminal renderer.** One atlas set per font key (font bytes, size, DPR, features), shared pipelines and bind group layouts, and one command encoder per coordinated frame across terminals. Optionally one shared surface, as in wraithterm's `feat/fleet-surface`. | Per-terminal resources and encodings are what still duplicate after device sharing; their share of the measured CPU growth is the experiment's question. | L (E2) |
| 9   | Batched cold rasterization: draw all missing glyphs of a frame into one canvas and read back once; warm printable ASCII at idle                                                                                                                                                    | Glyph raster is about 85% of measured stage time on glyph churn                                                                                          | M (E3) |
| 10  | Worker pool: one worker hosts N terminals with one runtime and device, and publishes compact binary row deltas instead of a structured-clone frame graph                                                                                                                           | Workers duplicate everything per terminal, and pre-touching the frame only moved cost (lane 01 §9)                                                       | L (E6) |
| 11  | Compact GPU records: a 16–24 byte cell record with shader-derived geometry, plus a sparse glyph stream for overhang and multi-glyph cells                                                                                                                                          | Halves or better the 320 B/cell (live + scratch) memory and dense-redraw uploads. Speed benefit unproven.                                                | L (E7) |
| 12  | Opt-in batched write API: bounded queue, time-budget yields, transferable input buffers to workers, parse acknowledgements; keep synchronous `write`                                                                                                                               | No backpressure today; xterm.js and wraithterm both bound their queues                                                                                   | M      |

### Investigate later (ambitious, lower confidence)

| #   | Idea                                                                                                                                       | Status                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 13  | Optional run shaper (HarfBuzz-WASM or harfrust) with explicit font files for ligatures and complex scripts, behind the glyph-key interface | Capability, not speed. Costs font assets, fallback policy and WASM size. Needs a cursor/selection/overhang correctness corpus first. |
| 14  | BiDi mapping (NimbleMarkets `nm-rtl` approach)                                                                                             | Correctness prototype, independent of renderers                                                                                      |
| 15  | Upstream proposal: a freestanding `font/sprite` module with explicit I/O                                                                   | Would make native Ghostty sprites available unpatched (lane 08 has the exact shape)                                                  |
| 16  | Adaptive idle-immediate presentation (render the first write to an idle terminal immediately, keep busy output on RAF)                     | wraithterm's claim is unverified; we already ship an explicit immediate mode                                                         |
| 17  | Fullscreen-fragment cell lookup or MSDF text                                                                                               | Not worth it now. ADR 002 already lost with compute-copy, and MSDF doesn't reproduce hinted small text or color emoji.               |
| 18  | Ghostty pin bump (Zig 0.17)                                                                                                                | Take it for its wide-cell selection and resize fixes when convenient; expect no speed change                                         |

### Don't do

- Adopt any patched Ghostty API (coder, NimbleMarkets, anomalyco, wraithterm, Restty). None buys a text capability the public C API lacks, and each adds rebase work (lane 02).
- Copy Restty's or yetty's full-viewport frame path, or Rio's full-buffer uploads.
- Replace the paged atlas with a fixed atlas that clears and rebuilds (Rio, wraithterm).
- Replace browser rasterization wholesale with a WASM font stack as the default. Browser fallback and color emoji come free from Canvas; keep any WASM stack opt-in.

## Experiment briefs

Each brief states the hypothesis, the change, what to measure, and the result that decides it. All run headed on hardware with the existing `bench:renderer` / `bench:compare` tooling and the L6 workloads. Ours versus ours is paired and counterbalanced in one session.

**E1. WebGPU fixed per-frame cost.**

- **Hypothesis:** most of WebGPU's extra CPU over WebGL2 is acquiring, clearing and redrawing on frames with no changes, plus per-frame GPU-process work.
- **Change:** in `src/render/webgpu/renderer.ts`, return before `getCurrentTexture` when `operations === 0` and no cursor, blink, selection, overlay, atlas or full-rebuild state changed. Keep the acknowledge and frame-record semantics.
- **Measure:** renderer + GPU-process CPU and frames submitted on ascii, cursor, rolling-logs and sparse-edit, on the PC and on the M1 (where WebGPU is the default backend).
- **Decision:** ship if repeated-output CPU drops by at least 30% with identical screenshots and no missed cursor or blink frames. If rolling-logs still shows WebGPU above WebGL2 by more than 20%, attribute the rest with a GPU-process trace before anything else.

**E2. Shared resources across terminals.**

- **Hypothesis:** per-terminal atlases, pipelines and render encodings cause most of the 1→32 CPU and memory growth.
- **Change:**
  - Step 1: share pipelines and bind group layouts per device.
  - Step 2: one atlas set per font key, with reference counting and the existing generation keys.
  - Step 3: one command encoder for all terminals in a coordinated frame.
- **Measure:** the lane 07a scaling matrix (1/4/16/32 at 80×24 and 4 at 200×50), CPU, JS heap, WASM, estimated GPU memory, p95 callback time; correctness through device loss and font change on one terminal while others share.
- **Decision:** proceed to a production design if 16 terminals use at least 30% less CPU or at least 50% less atlas memory with identical output. Kill step 3 if the shared encoder adds latency for the busiest terminal.

**E3. Cold glyph batching.**

- **Hypothesis:** per-glyph `fillText` plus readback dominates cold cost; batching misses per frame and reading back once cuts it substantially.
- **Change:** batch in `src/render/shared/atlas/canvas-rasterizer.ts` and `zig-glyphs.ts`, keeping full-key indexing; add idle ASCII warmup.
- **Measure:** glyph-churn and cold-cache stage costs, time to first frame, pixel equality of the atlas.
- **Decision:** ship at ≥40% less glyph-raster time with pixel-identical glyphs. Warmup ships only if it doesn't delay first content.

**E4. Procedural sprites.**

- **Hypothesis:** drawing box, block, braille, sextant and powerline characters procedurally fixes seams at fractional DPR and odd cell sizes and costs less than font raster.
- **Change:** a sprite rasterizer before `fillText`, with geometry taken from Ghostty's `src/font/sprite/draw/*` (pinned revision) as reference, not copied.
- **Measure:** a contact sheet at 9×18, 13×27 and 18×36 and at DPR 1, 1.25, 2 against native Ghostty screenshots; NTCharts heatmap and the L6 Unicode workload.
- **Decision:** ship when seams disappear and output matches native geometry within one device pixel.

**E5. WebGL2 stable rows.**

- **Hypothesis:** porting the WebGPU row-remap to WebGL2 (a row-offset texture or uniform) brings scroll uploads from ~941 KB to near zero.
- **Measure:** the scroll stage cost and upload bytes, both GPU backends.
- **Decision:** ship if WebGL2 scroll CPU drops by at least 30% with identical pixels.

**E6. Worker pool with binary deltas.**

- **Hypothesis:** one worker hosting N terminals, with compact row-delta publication, beats N workers each cloning full frames.
- **Change:** a prototype on WebGL2 first (it works in the PC's current state).
- **Measure:** host main-thread time per published frame, worker CPU, memory at 4/16 terminals, input-to-acknowledge latency.
- **Decision:** proceed if host publication cost drops by at least 50% and 16-terminal memory by at least 30%.

**E7. Compact records.**

- **Hypothesis:** a 20-byte cell record plus a sparse glyph-overflow stream cuts dense-redraw upload and memory without hurting sparse or scroll paths.
- **Measure:** dense-redraw, NTCharts and plasma stage costs, plus WASM and GPU buffer memory.
- **Decision:** ship only if dense-redraw CPU drops by at least 20% and sparse/scroll don't regress. Memory alone isn't enough to justify the refactor.

**E8. Re-run the blocked comparisons.**

- **Change:** none; this re-runs the comparisons the PC session couldn't.
- **Measure:** run lane 07b's retained wraithterm and NimbleMarkets adapters on a host with a working WebGPU device. This is the only way to learn whether wraithterm's compact cells and in-WASM fonts beat our design end to end.
- **Decision:** it decides how far to push E7 and item 13.

## Decision

- **Keep:** the unpatched core, the shared-memory bridge, retained records with range uploads, the paged atlas, instanced rendering and the fallback chain. The evidence says they are the strongest parts of the project.
- **Change first:** land DEC 2026 (#6), stop WebGPU from redrawing frames that changed nothing (E1), size atlases on demand, give WebGL2 stable rows (E5), fix the bridge seams, and add per-terminal visibility. All are small and local, with measured or source-proven waste behind them.
- **Investigate next:** shared multi-terminal resources (E2) and the worker pool (E6) have the highest ceiling, because terminal count is where we scale worst. Cold glyph batching (E3) and procedural sprites (E4) are the text-quality and cold-path work.
- **Leave alone for now:** run shaping, BiDi and compact records are real gaps, but each needs a correctness corpus or the blocked wraithterm comparison (E8) before it earns a refactor. Don't adopt patched Ghostty APIs, fixed clear-and-rebuild atlases, full-viewport frame rebuilding or MSDF.

## Owner decisions

- The PC's desktop compositor (Hyprland) held 6.96 GiB of the RTX 3060 Ti's 8 GiB during this study, and new browsers stopped getting WebGPU devices. Restarting the desktop session, or a quiet hour on the M1, would unblock E1 on hardware, E8, and GPU completion and presentation timing.
