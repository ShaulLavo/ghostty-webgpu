# November 2026 comparison data

`results.json` holds every number in the November section of [benchmarks.md](../../benchmarks.md). `scripts/benchmark-report-2026-11.ts` turns it into that section; `../mac-m1-2026-10-10/report.mjs` calls it and writes the whole page. Regenerate and check, from the repository root:

```sh
node docs/benchmarks/mac-m1-2026-10-10/report.mjs
node docs/benchmarks/mac-m1-2026-10-10/report.mjs --check
```

## What is in `results.json`

- `speed.<host>.cpu`: whole-browser CPU seconds per workload, terminal count (1 or 16) and backend, mean of two repetitions.
- `speed.mac.energy`: Mac process-family CPU energy in joules (`proc_pid_rusage`, `RUSAGE_INFO_V6`), same cells.
- `speed.<host>.ackP95`: p95 milliseconds of the paced acknowledgement, timed from the start of a step's write batch until every terminal has acknowledged parsing it. For `write-queue-overload` it is the p95 of each queued write's own acknowledgement.
- `speed.<host>.forcedP95`: p95 milliseconds from the start of a write batch until the forced draw completes on the GPU, for the libraries that can force one (ours on the main entry, Wraith).
- `speed.<host>.runs`: browser runs behind the speed cells; every one passed the display check before and after its workloads.
- `size`: KiB that one terminal on its best renderer downloads, raw, gzip -9 and brotli 11, with its font file.
- `coldLoad.<host>.<profile>`: milliseconds from navigation to the first compositor frame showing the probe text, median and p95 of 10 runs.

Speed values keep six significant digits of the unrounded mean, so the page ranks backends and computes ratios before rounding for display. A cell that holds a string instead of a number did not produce a comparable value: `unsupported` (the library has no API for the workload, such as a public glyph-atlas reset), `text-mismatch` (its final screen text differs from the other libraries) or `crash`.

Backends: `ours-main-*` is the main-thread entry, `ours-worker-*` runs one worker per terminal, `ours-pool-*` shares a `TerminalWorkerPool` of 4 workers. Competitors are xterm.js (WebGL addon and DOM), ghostty-web (Canvas 2D), Wraith (WebGPU, one worker per terminal) and Restty (WebGPU and WebGL2).

## Where it came from

Measured on commit `b4a279a1cb5c76191423fcdcafa5bddaa15afdb9` (0.3.34) on 2026-11-24, on a Linux PC with an RTX 3060 Ti (DPR 1) and an M1 MacBook on AC power (DPR 2), in headed Chromium 153 on the hardware GPU. The harness lives outside this repository. It gives every library the same bytes, 100x30 grid, font file and DPR, caps history at 10,000 lines for ours, xterm.js and Wraith and at a 64 MiB scrollback budget for ghostty-web and Restty, and compares final screen text across libraries.

The display check runs before and after every run. Each terminal is filled with a known colour; its drawing surface must lie inside its section and the viewport, be visible with an intersection ratio of at least 0.99, and not be covered at five sampled points. A browser trace across the fill must then contain compositor draw or swap events. Those events are browser-wide: they show the browser drew a frame, not that each terminal's own pixels reached the screen. A failed check before a run stops it before measuring; a failed check after a run is recorded with that run.

Our eight backends were run on that commit. Main-entry cold-load and download-size rows were refreshed after Canvas-first startup landed (`6e488dd51feca6b4b6a8ad85d512758eb914e002`; transfer sizes re-measured directly on `6e488dd51`, paired PC and Mac cold-load runs from the PR #167 series on `8d02570c4` with the same startup path). The competitor values come from a session a few hours earlier on the same machines with the same harness, bytes and page; xterm.js WebGL and Wraith were re-run next to ours as a drift check and moved a median 1.006 on the PC and 0.997 on the Mac (`drift`). The speed values are the unrounded means from the raw run files; each one rounds to the value in the harness's published table.

## Limits

- One-terminal cells are about 0.1 s of CPU and move by about 10% between sessions. Repetition-to-repetition spread was 4% median and 8% at p75; the page counts a ratio between 0.90 and 1.10 as even.
- Cell sizes are each library's own, so ours and xterm.js paint about 19% more pixels than Wraith and ghostty-web.
- Energy excludes GPU-device, display and whole-system power.
- Cold load uses its own setup (a 720x400 CSS px box, 80x20 cells for xterm.js, ghostty-web and Wraith, about 83x22 for ours and Restty, device scale factor 2). On the PC, our main entry paints its first frame on Canvas 2D before handing off to the GPU, while xterm.js WebGL2 remains bimodal (about 222 or 270 ms per load).
