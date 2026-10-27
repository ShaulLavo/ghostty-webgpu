# Shared drawing surface for many terminals

Status: decided; retained experiment, production deferred. Date: 2026-10-27. Prototype: immutable commit `a80617b148dc25f11af43d98bc10b6951e2a1f7c`, kept as branch `research/shared-surface-prototype` and in the history of `research/shared-surface`. Paths below marked `@a80617b1` exist only at that commit. Follows X1 ([PR #28](https://github.com/ShaulLavo/ghostty-webgpu/pull/28)), ledger rows A05–A09, B19, C04 and C06.

## Decision

| Scope                      | Verdict                                          | Why                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGPU on Linux            | **RETAIN** as an experiment; production deferred | PC performance sub-gate passed: 16 busy terminals 58.1 → 22.2% total CPU (−62%), GPU process 46.4 → 11.5%, equal text, 16 byte-identical pane screenshots, acknowledgement latency unchanged. But WebGL2, the Linux default, is cheaper in the same session, and one-busy cases regress. |
| WebGPU on macOS            | **REJECT**                                       | 16 busy terminals: 45.7 → 46.0% (flat). With one busy terminal the surface costs more: +13% at 16, +38% at 32, +11% for a single terminal. Keep per-terminal canvases on the Mac.                                                                                                        |
| Per-pane copies (any form) | **REJECT**                                       | Copying one shared target into N WebGPU canvases costs what N canvases cost (48.8 vs 52.9% GPU process at 16). Copying into N 2D canvases costs more (77.7%).                                                                                                                            |

The combined gate was ≥30% less total CPU at 16 terminals on the PC, no Mac regression, equal output and a qualified checklist. It was not met. The PC performance sub-gate passed by a wide margin. The Mac regresses, and several checklist items remain open (below).

The prototype is retained for one eventual use: an **opt-in Linux WebGPU pane group with many simultaneously updating terminals**, particularly a consumer that exceeds Chromium's WebGL context budget. Backend defaults stay unchanged, macOS is excluded and Windows is unmeasured. **Production work is deferred until a real consumer needs that case.** Reopen it with a same-session comparison against that consumer's actual default and fallback backend and its busy-pane mix, an agreed one-busy cost, memory and size limits, and the open correctness checks. The production steps below are conditional follow-up work, not scheduled implementation.

The product impact is narrow today. Desktop Linux selects WebGL2 first, and in the same session WebGL2 stays below the shared surface in every case (16 busy terminals: 24.2% WebGL2, 26.6% shared surface, 63.0% today's WebGPU). The surface makes WebGPU on Linux nearly as cheap as WebGL2 for many busy terminals. It could matter where WebGPU is used on Linux anyway, and past 16 terminals, where stock Chromium refuses more WebGL2 contexts (lane 07a). At 32 busy terminals the surface runs at 32.6% instead of 95.3%, but that compares two WebGPU designs. It does not show the surface beats an application's default or fallback strategy at that count.

## Attribution: what the probe measured

PR #28 left open whether per-canvas compositing explains the X1 probe. Canvas or layer count alone does not explain it. On this Linux browser and driver, the measured overhead follows active WebGPU canvas presentation: it grows with the number of WebGPU canvases presented per frame, on the GPU process main thread. The compositor is not ruled out. About 25 of the points sit in display-compositor swap and image access for those canvases.

The probe (`bench/shared-surface/probe.ts@a80617b1`) extends X1's with controls, 300 frames per arm, two repetitions in reversed order. The equal-work arms draw 1,920 instanced quads into each of N 1280×768 tiles every frame: N WebGPU canvases, one canvas holding N tiles, N offscreen targets, and the two copy designs. Two controls do less work. "N canvases, one updated" draws only the first tile. "N 2D canvases, each filled" does no WebGPU drawing and fills a 64×64 rectangle in each canvas. CPU is CDP `SystemInfo.getProcessInfo` `cpuTime` per process type, `100 × Δ CPU s / wall s`. It is host CPU, not GPU time.

GPU-process CPU %, PC (Linux, Wayland, RTX 3060 Ti); all-Chrome total in parentheses:

| Tiles | N WebGPU canvases | One canvas, N tiles | N offscreen targets, no canvas | N canvases, one updated | One target copied to N WebGPU canvases | One target drawn into N 2D canvases | N 2D canvases, each filled |
| ----- | ----------------- | ------------------- | ------------------------------ | ----------------------- | -------------------------------------- | ----------------------------------- | -------------------------- |
| 1     | 8.8 (12.1)        | 8.8 (12.2)          | 1.4 (2.7)                      | 9.2 (12.4)              | 10.2 (14.0)                            | 14.5 (19.5)                         | 4.3 (7.5)                  |
| 4     | 16.4 (19.6)       | 7.5 (10.3)          | 1.6 (3.3)                      | 8.4 (11.3)              | 17.2 (20.4)                            | 25.2 (29.8)                         | 5.3 (8.8)                  |
| 16    | 52.9 (57.3)       | 8.4 (11.4)          | 2.4 (3.9)                      | 8.0 (10.7)              | 48.8 (52.8)                            | 77.7 (85.2)                         | 8.0 (11.8)                 |
| 32    | 89.1 (95.4)       | 8.8 (12.0)          | 2.8 (4.5)                      | 8.5 (11.6)              | 87.5 (92.9)                            | 101.6 (109.0)                       | 10.2 (14.0)                |

- N render passes into N targets cost 2.4% at 16. Passes, attachments and encoders are not the cost.
- Reduced-work control: sixteen WebGPU canvases with only one presented per frame cost 8.0%. Idle canvases add nothing measurable. The cost follows canvases presented per frame, which is the number of busy terminals.
- Reduced-work control: sixteen accelerated 2D canvases updated every frame cost 8.0%. So sixteen updating layers alone do not produce the cost. This is not an equal-damage compositing control: each fill damages 64×64 pixels, while WebGPU replaces whole tiles. It does not exclude compositor work specific to WebGPU canvas images.
- The GPU-process trace at 16 tiles (`trace-summary.ts`) puts the N-canvas cost on `CrGpuMain`: 50.6% traced, against 7.8% for one canvas. Per WebGPU canvas it grows in four places: `SkiaOutputSurfaceImplOnGpu::SwapBuffers` 12.9% (1.3% with one canvas), `Begin/EndAccessImages` 12.4% (1.9%), the WebGPU decoder `CommandBufferService:PutChanged` and `PerformPollingWork` 18.5% (2.2%), and `Queue::Submit` 4.6% (0.8%). Draw-quad work in viz stays under 0.5%. The trace localizes the work; it does not rule the compositor out. Two explanations remain open: WebGPU-specific compositor image handling, and cross-API synchronization when the GL-based display compositor reads each Dawn (Vulkan) canvas image. The synchronization explanation is unproven.

On the Mac the same probe gives 31.6% for 16 canvases against 27.6% for one canvas, and 2D canvases cost more than WebGPU ones (42.0%). The trace covers only 9.4% of the Mac GPU process, with no dominant per-canvas slice. The untraced remainder grows with the presented area, consistent with X1's Core Animation hypothesis. One canvas helps the Mac only where it does not enlarge the presented area.

## Designs compared

| Design                                                                 | Result                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One WebGPU canvas behind a pane group, panes copied into it each frame | Prototyped in the renderer. The only topology that removes per-canvas presentation. Measured below.                                                                           |
| One shared offscreen target plus per-pane copies into pane canvases    | Probe: as costly as N canvases with WebGPU canvases, worse with 2D canvases. Rejected without a renderer prototype.                                                           |
| One overlay canvas over the page, above content                        | Same presentation win, but terminal pixels then cover menus and popups over a terminal. Rejected for embedding; the prototype puts the surface under the container's content. |
| Viewport-sized sticky surface, recomposited on scroll                  | Bounds memory and the texture-size cap, but scroll becomes main-thread work one frame behind the compositor. Not built; a fallback for scroll content beyond the cap.         |
| A common GL framebuffer with per-pane copies (C06)                     | Already rejected on total memory; a WebGL2 shared surface was not tried here.                                                                                                 |

## The prototype

`src/render/webgpu/shared-surface.ts@a80617b1` adds `WebGpuSharedSurface(container)` and a `RenderTarget` seam in the WebGPU renderer. None of it is on `main`.

- The surface prepends one canvas to the container: absolutely positioned at the content origin, `z-index:-1` in an isolated stacking context, `pointer-events:none`. It sits above the container's background and below its content, and scrolls with the content.
- A renderer created with `surface` keeps its own `<canvas>` element for layout, padding and pointer events, but never gives it a context. It draws its unchanged frame into a retained pane texture of the same size.
- `FrameCoordinator` appends one composite command buffer per surface to the coordinated `queue.submit`, after every pane's command. The composite acquires the surface texture and copies each visible pane to its rounded device-pixel position, clipped to the canvas and to rectangular `overflow` ancestors inside the container. Commit, acknowledgement and frame observers are unchanged.
- A `ResizeObserver` on the container and on each pane element requests a composite on layout changes. `invalidate()` covers the rest, such as a move without a resize or `visibility:hidden`.
- When the last pane leaves, the surface unconfigures its canvas. Disposing that pane can release the shared device, so the surface does not composite again.

## Results in the terminal path

Fleet benchmark (`bench/shared-surface/fleet.ts@a80617b1`): N production-default WebGPU renderers (shared device and frame coordinator), DPR 2, 13 px monospace, in a 1600×1000 scrolling grid. Thirty warm-up updates, then 300 paced updates of ten lines each, written to every terminal ("all") or only the first ("one"). Arms are counterbalanced in ABBA order, one fresh page each, two repetitions. Every tenth line carries a wide CJK glyph, a precomposed `é` (U+00E9), a ZWJ emoji, italic and bold. It contains no combining sequence. Latency is for the first terminal. "Ack" runs from `write()` to the `acknowledge()` inside the coordinated frame's commit. "Next frame" runs to the next animation frame after it, a stand-in for presentation, not a measured photon time.

### PC (Linux, NVIDIA, Chromium 153.0.8010.12)

| Case     | Busy | Total CPU %        | GPU process % | Renderer %  | Ack p95/p99 ms        | Submitted   |
| -------- | ---- | ------------------ | ------------- | ----------- | --------------------- | ----------- |
| 80×24×1  | all  | 17.9 → 17.1 (−5%)  | 11.3 → 10.9   | 5.3 → 5.1   | 16.8/17.5 → 16.9/17.1 | 300 → 300   |
| 80×24×4  | all  | 21.7 → 14.1 (−35%) | 16.4 → 8.5    | 4.5 → 4.6   | 16.9/18.0 → 16.8/17.0 | 1200 → 1200 |
| 80×24×16 | all  | 58.1 → 22.2 (−62%) | 46.4 → 11.5   | 10.8 → 9.7  | 17.2/19.0 → 17.2/17.5 | 4800 → 4800 |
| 80×24×32 | all  | 95.3 → 32.6 (−66%) | 76.6 → 15.0   | 17.6 → 16.5 | 17.8/20.1 → 17.5/17.9 | 9600 → 9600 |
| 200×50×4 | all  | 22.3 → 15.2 (−32%) | 14.6 → 8.8    | 6.8 → 5.8   | 17.0/17.2 → 16.9/17.1 | 1200 → 1200 |
| 80×24×1  | one  | 15.1 → 15.3 (+2%)  | 9.8 → 9.7     | 4.3 → 4.5   | 16.8/17.1 → 16.8/16.9 | 300 → 300   |
| 80×24×4  | one  | 11.5 → 10.9 (−5%)  | 7.8 → 7.5     | 3.0 → 3.0   | 16.9/17.0 → 16.9/17.1 | 300 → 300   |
| 80×24×16 | one  | 15.8 → 17.1 (+9%)  | 10.3 → 11.3   | 4.4 → 4.8   | 16.9/17.5 → 16.9/18.8 | 300 → 300   |
| 80×24×32 | one  | 15.1 → 17.4 (+16%) | 9.9 → 11.2    | 4.2 → 5.3   | 16.8/16.9 → 16.8/17.0 | 300 → 300   |
| 200×50×4 | one  | 11.8 → 13.2 (+12%) | 7.6 → 8.8     | 3.5 → 3.7   | 16.9/17.0 → 16.9/17.2 | 300 → 300   |

With one busy terminal among many, the surface still copies every pane and presents the whole surface each frame. On Linux that costs 1.3–2.3 points.

Same-session three-arm run on the PC (total CPU %, two repetitions, arms rotated):

| Case     | Busy | Own WebGPU canvases | Shared surface | WebGL2 (Linux default) |
| -------- | ---- | ------------------- | -------------- | ---------------------- |
| 80×24×1  | all  | 18.2                | 16.6           | 9.3                    |
| 80×24×4  | all  | 30.8                | 17.7           | 12.9                   |
| 80×24×16 | all  | 63.0                | 26.6           | 24.2                   |
| 200×50×4 | all  | 32.1                | 25.3           | 19.2                   |
| 80×24×16 | one  | 18.2                | 20.4           | 11.3                   |

### Mac (M1, Metal, Chromium 153.0.8010.12, AC power, load 2–3.7, experimental)

| Case     | Busy | Total CPU %        | GPU process % | Renderer %  |
| -------- | ---- | ------------------ | ------------- | ----------- |
| 80×24×1  | all  | 33.8 → 34.8 (+3%)  | 17.9 → 22.3   | 13.8 → 11.8 |
| 80×24×4  | all  | 35.9 → 35.3 (−2%)  | 20.5 → 20.2   | 15.0 → 14.8 |
| 80×24×16 | all  | 45.7 → 46.0 (+1%)  | 29.1 → 26.8   | 16.4 → 18.9 |
| 80×24×32 | all  | 64.3 → 59.7 (−7%)  | 41.6 → 38.5   | 22.6 → 21.0 |
| 200×50×4 | all  | 40.7 → 43.2 (+6%)  | 28.0 → 30.2   | 12.5 → 12.8 |
| 80×24×1  | one  | 31.3 → 34.6 (+11%) | 17.5 → 22.1   | 13.1 → 12.0 |
| 80×24×16 | one  | 33.4 → 37.7 (+13%) | 19.5 → 27.4   | 13.5 → 10.0 |
| 80×24×32 | one  | 32.4 → 44.6 (+38%) | 18.3 → 37.7   | 13.8 → 6.7  |
| 200×50×4 | one  | 34.9 → 42.4 (+21%) | 20.9 → 32.7   | 13.7 → 9.4  |

Mac acknowledgement p95 stays within 17.5–18.4 ms in both arms.

### Equal output

- Text: every terminal's text hash matches across both arms in every record on both hosts (one hash per terminal per record).
- Submitted frames match per case, and per-terminal frame and acknowledgement counts are recorded in the raw data.
- Pixels, 16 × 80×24, all busy: on the PC all 16 per-pane screenshots are byte-identical between arms. On the Mac 14 of 16 are; panes 10 and 14 differ only in a 14-pixel column at x 1182–1196, the macOS overlay scrollbar of the scrolling container fading (≤3 levels). Terminal pixels are identical.
- Browser tests compare each pane against its own-canvas rendering in the same layout (below). They also use the precomposed `é`.
- **Not covered:** combining sequences such as `e` + U+0301. The equality above holds for this workload only. Pixel coverage of genuine combining sequences is pending before any production qualification.
- These records compare text, counts and screenshots. They do not measure presented-frame identity or exercise public frame observers.

## Checklist

| Requirement                     | Status                                                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent DOM input elements  | Kept. Each terminal keeps its own canvas element, textarea and pointer target; the surface has `pointer-events:none`. Test: two `Terminal`s on one surface receive their own keystrokes and focus.                                              |
| CSS clipping                    | Rectangular `overflow` ancestors between pane and container: kept (test). `border-radius`, `clip-path`, masks and transforms on a pane or between it and the container: **not supported**; their pixels are copied unclipped and untransformed. |
| Z-order and transparency        | Terminal pixels sit above the container's background and below all of its content. Transparent cells show the container background. **Constraint:** any opaque background between the container and a pane hides that terminal.                 |
| Per-pane CSS opacity or filters | **Not supported.** A copy ignores them.                                                                                                                                                                                                         |
| Scroll-container movement       | Kept with no main-thread work: the canvas scrolls with the content (test: no composite on scroll, same pixels). Cost: the canvas covers the whole scrollable content.                                                                           |
| Fractional geometry and DPR     | Pane origins round to device pixels and land where the pane's own canvas lands (test at a 10.3/7.6 px offset, DPR 1). DPR changes refit the surface on the next composite; not tested with a real monitor change.                               |
| Resize                          | Pane resize reallocates its texture (test). Container resize recomposites through `ResizeObserver`. The surface never shrinks below content it once covered (prototype bug).                                                                    |
| Occlusion and visibility (#12)  | `display:none` drops a pane automatically; `visibility:hidden` needs `invalidate()` (test). Paused offscreen terminals keep their retained texture.                                                                                             |
| Disposal and re-entry           | A disposed pane disappears on the next composite; a new renderer on the same element repaints (test). The last pane leaving blanks the canvas.                                                                                                  |
| Device loss                     | Destroying the shared device restores every pane onto one replacement device, and the surface reconfigures to it (test).                                                                                                                        |
| Size limit                      | **Open.** Content larger than `maxTextureDimension2D` (8192 by default, 4096 CSS px at DPR 2) cannot be covered. The 32-terminal grid used 7200×5760.                                                                                           |
| Worker entry                    | **Not covered.** The worker entry runs each terminal in its own worker, so panes cannot share a canvas. It needs a pooled worker (E6).                                                                                                          |

## Memory

`nvidia-smi` free-memory deltas swung by ±150 MiB between repetitions because other GUI processes share the GPU, so they are not usable. Logical sizes at 16 × 80×24 on the PC: each pane is 1200×960 RGBA, 4.4 MiB. Today that is 16 canvases, each with its swap-chain images in flight. The prototype adds 16 retained pane textures (70.3 MiB) plus one 4800×3840 surface (70.3 MiB per swap-chain image). So it holds roughly one extra copy of every pane. Drawing panes straight into the surface would remove the retained textures but redraw idle panes every frame. At 32 terminals the surface is 158 MiB per image, because it spans the whole grid.

## Conditional follow-up: production steps

Not scheduled. This is the ready plan for when a consumer needs an opt-in Linux WebGPU pane group with many busy terminals, and only after the reopening comparison described in the decision. The prototype stays at `a80617b1`.

1. **Scope.** Offer the surface only for WebGPU on non-Apple platforms, through an explicit pane-group API (`TerminalSurface`, the main entry's `surface` option passed to the WebGPU renderer). Measure Windows before enabling it there. Leave the Linux default on WebGL2; reconsider only if a same-session comparison puts the surface below WebGL2.
2. **Sizing.** Size the canvas to the union of pane boxes, not the whole container. That removes the single-terminal and sparse-layout cost. Fall back to per-pane canvases when the union exceeds `maxTextureDimension2D`. Shrink when content shrinks.
3. **Layout tracking.** Keep `ResizeObserver`, and recomposite on moves and visibility changes it cannot see. Either the host calls `invalidate()` from its layout code, or the surface also watches `IntersectionObserver` and style mutations. Read pane boxes once per composite after layout, as now.
4. **Failure isolation.** A composite that throws now fails every pane frame in that device group. Submit pane commands first and the composite separately, report surface failures once, and recover the canvas context.
5. **Memory option.** Measure drawing panes directly into the surface, with no retained textures, against the copy design. Keep whichever has lower total memory at equal CPU.
6. **Documented constraints.** Panes need transparent ancestors up to the container; no per-pane opacity, filters, transforms or non-rectangular clips; terminal pixels sit under the container's content.
7. **Tests to add.** Genuine combining sequences (`e` + U+0301) in pixel comparisons, real DPR change, container shrink, size-cap fallback, a pane moved without a resize, public frame observers, and composite failure isolation.
8. **One-busy cost.** On Linux the surface costs +9–16% total CPU when one of 16–32 terminals is busy. Accept it, or present per-pane canvases while one pane is busy and switch to the surface when several are.

## Method and evidence

- Hosts. PC: i7-14700K, RTX 3060 Ti, NVIDIA 615.78.08, headed Chromium 153.0.8010.12 on native Wayland, WebGPU on the NVIDIA adapter; VRAM ≥ 2 GiB checked before each page; runs through the shared queue in quiet mode. Mac: M1 MacBook Air, macOS 26.4, same Chromium, Metal, AC power, under the agent lock; background load 2–3.7, so Mac numbers are experimental.
- Source: `bc1b8c4cc` on `research/shared-surface` plus the working diff stored with each run (format changes, the WebGL2 arm and the last-pane clear). Mac runs used `bc1b8c4cc` unmodified.
- Raw data, traces, screenshots, run scripts and summarizers: `/work/reports/ghostty-webgpu-next-2026-10/shared-surface/` (`probe-pc/`, `fleet-pc/`, `fleet-pc-webgl2/`, `mac/`). `python3 summarize.py <fleet.json>` and `python3 probe-summary.py <probe.json>` reprint every table; `bun bench/shared-surface/trace-summary.ts <trace.json>` at `a80617b1` reprints the trace attribution (traces are stored gzipped).
- Browser tests: `src/render/tests/shared-surface.browser.test.ts@a80617b1` (SwiftShader, correctness only; 9 pass there, and the full suite passed at that commit).
- All CPU figures are two-repetition means and experimental, not qualified speedup claims.
