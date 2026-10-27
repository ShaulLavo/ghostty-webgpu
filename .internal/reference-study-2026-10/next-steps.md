# Next steps after the reference study

Status: Approved. Date: 2026-10-27. Source: [the study](README.md), merged at `d2ed8989a`.

This is the execution plan for everything the study found. Every item has an ID, a gate, and a done condition. An item is done when its PR is merged, or when its experiment has a recorded keep or reject decision in `.internal/`. Experiment IDs (E1–E8) and item numbers match the study.

## Ground rules

- **Baseline first, then change.** Every performance item gets a same-session before/after pair on hardware, using the existing `bench:renderer` / `bench:compare` tooling, the study's workloads (`/work/reports/ghostty-webgpu-reference-study-2026-10-27/bench/workloads/`), and the lane 07a reproducer.
- **Equal output is a prerequisite.** Every performance PR shows equal text and pixels, including wide, combining, overhanging and color glyphs, and equal delivered updates. A speedup that skips work is a failure.
- **Two hardware hosts, used in turns.**
  - PC: RTX 3060 Ti, Linux. WebGL2 is the default backend there.
  - M1 Mac: WebGPU is the default backend there.
  - Each PR's numbers name the host.
- **Check VRAM before every headed window on the PC.** During the study, Hyprland's GPU memory grew to 6.96 GiB with many headed benchmark windows, and WebGPU device creation failed. It is back to 175 MiB. Before each window, check `nvidia-smi`; stop if free VRAM is under 2 GiB. Keep one headed browser at a time, and close windows between cohorts.
- **One PR per item**, each with an independent reviewer that isn't its author. Changes that touch the same files land in order (see Dependencies).

## Phase 0: Unblock measurement and record baselines

These run first, because Phase 1 needs their numbers as controls.

| ID  | Work                                                                                                                                                                                                                                                                                 | Host         | Done when                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------- |
| M1  | Baseline packet at current main for E1, E3, E5 and the bridge seams: stage costs, upload bytes, frames submitted, CPU (renderer + GPU process) on ascii, cursor, rolling logs, sparse edit, dense redraw, glyph churn, cold cache, viewport scroll, NTCharts heatmap, OpenTUI plasma | PC and Mac   | Packet archived under `.internal/benchmarks/` with source SHA, browser, adapter |
| M2  | WebGPU completion and presentation timing (`onSubmittedWorkDone`, timestamp queries, existing presentation endpoint); WebGPU worker entry                                                                                                                                            | PC, then Mac | Numbers recorded, or the exact blocker                                          |
| M3  | E8a: wraithterm complete-terminal comparison with lane 07b's retained adapter (`patches/L7b`), against ours WebGPU/WebGL2 and xterm.js, on the L6 chunks with matched geometry                                                                                                       | PC and Mac   | Results table with backend labels; wraithterm's verdict decides E7's priority   |
| M4  | E8b: build and qualify a NimbleMarkets `nm-webgpu` adapter (geometry, text), then run it in the M3 cohort                                                                                                                                                                            | PC           | Same as M3, or a recorded reason to drop it after 45 minutes                    |
| M5  | Monitor DPR change and real hidden-tab behavior, manual headed session                                                                                                                                                                                                               | Mac          | Short note with screenshots                                                     |

## Phase 1: Small, local fixes (start in parallel with Phase 0)

Each one is a single PR with a failing-first test where behavior changes, plus a before/after against M1.

| ID  | Item                                                                                                                                                                                                                                 | Evidence                                                                            | Done when                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Synchronized output (DEC 2026) hold                                                                                                                                                                                                  | Lanes 01, 05                                                                        | Done: #6                                                                                                                                                                                     |
| F2  | **E1**: WebGPU skips acquire, encode and submit when a damage-bearing update rebuilds identical records and no cursor, blink, selection, overlay, atlas or full-rebuild state changed. Resize, reconfigure and recovery always draw. | `renderer.ts:520-528` vs WebGL2 `renderer.ts:424`; 14% vs 4% CPU on repeated output | Merged with ≥30% less CPU on repeated output, same screenshots, no missed cursor or blink frames. If rolling logs still shows WebGPU >20% above WebGL2, add a GPU-process trace to M2.       |
| F3  | Demand-sized atlas (start at one or two layers per kind, grow) plus page-local eviction recovery instead of `invalidateAll()`                                                                                                        | 20 MiB per terminal; `zig-glyphs.ts:19-23,49-52`, `atlas.ts:272-277`                | Merged with atlas-pressure tests: an old visible glyph survives churn elsewhere; a visible set beyond capacity degrades without repeated full rebuilds; memory at 1/16/32 terminals recorded |
| F4  | **E5**: stable rows (row indirection) for WebGL2                                                                                                                                                                                     | 941 KB vs 120 B per scroll update                                                   | Merged with ≥30% less WebGL2 scroll CPU and identical pixels                                                                                                                                 |
| F5  | Bridge: native clean call instead of 2R+D+3 JS→core calls per acknowledgement                                                                                                                                                        | `render-state.ts:287`                                                               | Merged; acknowledgement call count and time recorded                                                                                                                                         |
| F6  | Bridge: hash-based row matching instead of O(R²)                                                                                                                                                                                     | `bridge.zig:332`                                                                    | Merged; 300×80 and 500-row viewports measured                                                                                                                                                |
| F7  | Upload ranges: split when the clean gap exceeds a measured threshold                                                                                                                                                                 | `upload-ranges.ts:26`                                                               | Merged with the threshold chosen from M1 data                                                                                                                                                |
| F8  | Per-terminal visibility (IntersectionObserver) into the scheduler and the worker visibility message                                                                                                                                  | Lane 05                                                                             | Merged; offscreen panes schedule no frames and catch up on return                                                                                                                            |

## Phase 2: Experiments that decide the refactors

Each one starts as a prototype on a research branch with a written keep or reject decision. Only a kept result turns into a production design PR.

| ID  | Experiment                                                                                                                                                                | Keep if                                                                                                                     | Depends on             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| X1  | **E2** shared resources across terminals: pipelines and layouts per device, then one atlas set per font key with reference counts, then one encoder per coordinated frame | 16 terminals: ≥30% less CPU or ≥50% less atlas memory, equal output, survives device loss and a font change on one terminal | F3 (atlas shape)       |
| X2  | **E3** batched cold glyph rasterization plus idle ASCII warmup                                                                                                            | ≥40% less glyph-raster time, pixel-identical atlas; warmup doesn't delay first content                                      | M1                     |
| X3  | **E4** procedural sprites in TypeScript ahead of `fillText` (box, block, braille, sextant, powerline), with Ghostty's draw tables as reference geometry                   | Seams gone at DPR 1, 1.25 and 2 and cell sizes 9×18, 13×27, 18×36; within one device pixel of native Ghostty screenshots    | none                   |
| X4  | **E6** worker pool: one worker hosts N terminals with one runtime and device, and publishes binary row deltas                                                             | Host publication cost −50%, 16-terminal memory −30%, equal output, busiest-terminal p95/p99 acknowledgement ≤1.2× today     | M2                     |
| X5  | **E7** compact records: ~20-byte cell plus a sparse glyph-overflow stream                                                                                                 | Dense-redraw CPU −20%, no sparse or scroll regression                                                                       | M3 (wraithterm result) |

## Phase 3: Capabilities

These are product choices more than speed work. Each starts with a correctness test set.

| ID  | Item                                                                                                                                                  | First step                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| C1  | Opt-in batched write API: bounded queue, time-budget yields, transferable input buffers to workers, parse acknowledgements; synchronous `write` stays | API sketch in `docs/`, then a prototype measured on throughput and input-to-visible latency together |
| C2  | Run shaping and ligatures (HarfBuzz-WASM or harfrust, explicit font files) behind the glyph-key interface                                             | Correctness set for cursor, selection and overhang splits, then a prototype                          |
| C3  | BiDi, following NimbleMarkets' `nm-rtl` visual/logical mapping                                                                                        | Correctness prototype independent of renderers                                                       |
| C4  | Ghostty pin bump (Zig 0.17) for wide-cell selection and resize fixes                                                                                  | Bump, rerun conformance and the browser suites                                                       |
| C5  | Adaptive idle-immediate presentation                                                                                                                  | Only after M2 provides presentation timing                                                           |

## Findings to close

| ID  | Finding                                                                                                                 | Action                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| B1  | Two render states on one terminal: only one receives incremental updates; it happens without DEC 2026 too               | Repro in `.internal/dec2026-hold.md`. Design shared-snapshot or independent damage, fix with a failing-first test. |
| B2  | Upstream proposal: a freestanding `font/sprite` module with explicit I/O, so native sprites need no patch               | Write it ready to file in `/work/reports/ghostty-upstream/README.md`, with lane 08's exact errors and shape        |
| B3  | coder/ghostty-web 0.4.0 crashes the renderer process on the 13th ZWJ-heavy write; empty writes reject with `RangeError` | Add a ready-to-file entry to `/work/reports/upstream-bugs/README.md` from lane 07b's `base-smoke` packet           |
| B4  | xterm.js 6.0.0 drops ZWJ joiners on the one-byte parser path                                                            | Same file, from the same packet                                                                                    |
| B5  | `.internal/program.md` still said development happens in the Fregat monorepo, with Fregat-root commands                 | Done in the plan's PR                                                                                              |
| B6  | `docs/concepts.md` says GPU renderers upload changed ranges without saying only WebGPU reuses rows on scroll            | One-line fix, folded into F4's PR                                                                                  |
| B7  | Untracked 19 MB `references/xterm.js` left in the shared checkout from a removed submodule                              | Delete after confirming nothing references it                                                                      |

## Dependencies and order

- **Can start right away:** M1 and M2 on the PC, F5–F8, X3 and B1–B4. None of them needs the others.
- **F2 (E1)** needs M1's WebGPU baseline from both hosts.
- **F3** lands before X1, because X1 shares the atlas F3 reshapes.
- **F4** and F6 both touch the bridge row plan. Land F6 first; F4 rebases on it.
- **X5** waits for M3. If wraithterm doesn't beat our dense path end to end, X5 drops to Phase 3.
- **X4** waits for M2's WebGPU worker numbers.

## Decisions

- **Ligatures (C2) and BiDi (C3) run after Phase 2** (owner left it to the coordinator, 2026-10-27). Neither is a gap against the ghostty-web baseline, and Phase 1 and 2 address measured costs. Their correctness test sets start during Phase 2, so the prototypes can begin as soon as Phase 2 ends.
- **Global instructions corrected** (owner, 2026-10-27): `~/.agents/AGENTS.md` now describes ghostty-webgpu, singapore and hotkeys as standalone repos.
