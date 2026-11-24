# November 2026 comparison data

`results.json` holds every number in the November section of [benchmarks.md](../../benchmarks.md). `report.ts` turns it into that section; `../mac-m1-2026-10-10/report.mjs` calls it and writes the whole page. Regenerate and check, from the repository root:

```sh
node docs/benchmarks/mac-m1-2026-10-10/report.mjs
node docs/benchmarks/mac-m1-2026-10-10/report.mjs --check
```

## What is in `results.json`

- `speed.<host>.cpu`: whole-browser CPU seconds per workload, terminal count (1 or 16) and backend, mean of two repetitions.
- `speed.mac.energy`: Mac process-family CPU energy in joules (`proc_pid_rusage`, `RUSAGE_INFO_V6`), same cells.
- `speed.<host>.ackP95`: p95 milliseconds from a write call to the library's parse acknowledgement.
- `speed.<host>.forcedP95`: p95 milliseconds from a forced draw to GPU completion, for the libraries that can force one (ours on the main entry, Wraith).
- `size`: KiB that one terminal on its best renderer downloads, raw, gzip -9 and brotli 11, with its font file.
- `coldLoad.<host>.<profile>`: milliseconds from navigation to the first compositor frame showing the probe text, median and p95 of 10 runs.

A cell that holds a string instead of a number did not produce a comparable value: `unsupported` (the library has no API for the workload, such as a public glyph-atlas reset), `text-mismatch` (its final screen text differs from the other libraries) or `crash`.

Backends: `ours-main-*` is the main-thread entry, `ours-worker-*` runs one worker per terminal, `ours-pool-*` shares a `TerminalWorkerPool` of 4 workers. Competitors are xterm.js (WebGL addon and DOM), ghostty-web (Canvas 2D), Wraith (WebGPU, one worker per terminal) and Restty (WebGPU and WebGL2).

## Where it came from

Measured on commit `b4a279a1cb5c76191423fcdcafa5bddaa15afdb9` (0.3.34) on 2026-11-24, on a Linux PC with an RTX 3060 Ti (DPR 1) and an M1 MacBook on AC power (DPR 2), in headed Chromium 153 on the hardware GPU. The harness lives outside this repository; it gives every library the same bytes, 100x30 grid, font file, DPR and history length, checks that each terminal is on screen and drawn before and after every run, and compares final screen text across libraries.

Our eight backends were run on that commit. The competitor values come from a session a few hours earlier on the same machines with the same harness, bytes and page; xterm.js WebGL and Wraith were re-run next to ours as a drift check and moved a median 1.006 on the PC and 0.997 on the Mac (`drift`).

The values were copied from the harness's generated tables, rounded as published there (CPU and energy to 3 decimals, latencies to 2). Ratios on the page are computed from these rounded values, so very small cells can differ by a few hundredths from a ratio computed on unrounded data.

## Limits

- One-terminal cells are about 0.1 s of CPU and move by about 10% between sessions. Repetition-to-repetition spread was 4% median and 8% at p75; the page treats gaps under 10% as even.
- Cell sizes are each library's own, so ours and xterm.js paint about 19% more pixels than Wraith and ghostty-web.
- Energy excludes GPU-device, display and whole-system power.
- Unthrottled WebGL2 first paint on the PC is bimodal (about 222 or 270 ms per load, xterm.js too), so its 10-run median can land on either mode.
