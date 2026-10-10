# Reviewed M1 terminal measurements, one-build standing

Published 2026-10-10 from the terminal performance wave's one-build standing. The windows ran on 2026-10-09 UTC. The publication runs no new measurements and makes no claim about builds after ghostty-webgpu 0.3.21.

[Public comparison page](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks.md) · [Scores](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/scores.json) · [Earlier set, 2026-10-08](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-08/README.md)

## What is saved

`scores.json` holds the nine published Mac rows: WebGL against xterm.js 6 WebGL and DOM against xterm.js 6 DOM, five and four workloads. Each row links its counter record and review cell. One DOM cell, one Unicode line per tick, has no qualified comparison and is listed as unavailable with its reason.

The source is ghostty-webgpu 0.3.21 at Fregat commit `fb67ac08ded224fd6579389a23796e015ee23d5c`, paired with xterm.js 6.0.0, WebGL addon 0.19.0 and, on one Unicode line per tick, Unicode 11 addon 0.9.0. The machine is an Apple M1 MacBook on AC power, running headed Chrome 154.0.8037.93 with hardware ANGLE Metal rendering. All nine cells used the corrected R08 harness, which prepares fixture inputs before the measured window.

Each workload has 17 visible 40 × 12 terminals at DPR 2, 120 warm-up ticks and 900 measured ticks paced at 60 Hz. Each cell has two chronological ghostty and xterm.js pairs, ordered ABBA or BAAB. The result is the median of the two pair ratios, not a ratio of separately calculated medians. Each workload ran in its own browser session, and a session can also hold windows of other renderers, so the two windows of a pair need not be adjacent.

Energy means macOS's kernel estimate of process CPU energy across the Chrome process family. Instructions are retired CPU instructions across those same processes. GPU-process CPU work is included. GPU-device and display energy are outside the measurement. Cycles, CPU seconds, core placement and effective clocks are diagnostics. CPU seconds are saved for context.

`counters/` holds compact copies of the original acquisition indexes. They keep per-process native deltas, aggregate channels, work counters, output hashes, final retained rows, times and the protocol. They omit large repeated text arrays, endpoint snapshots, geometry and screenshots. The WebGL sessions also timed WebGPU windows; those are omitted and named in `omittedActors`. `originalIndexSha256` identifies the complete private acquisition.

`reviews/r12-standing-mac.json` keeps the independent review's cells for these ten Mac comparisons, with private paths removed. It carries each cell's verdict, pair outcomes, history rows, drawing buffers, website statement and required footnotes, plus the review's method, publication limits and prohibited claims. The review covers 100 cells on three machines. The other cells are not part of this set.

## Review limits

- The review marks every published cell publishable with limits. It approves no unrestricted headline, so nothing here supports a claim that ghostty is faster on every workload.
- Each cell has two pairs. The results are descriptive and carry no significance test.
- The benchmark observer is enabled and its overhead is not calibrated. No overhead is subtracted.
- Qualification checks equal public writes and bytes, the registered final retained output, Unicode cell widths where registered, logical settlement, stable same-actor screenshots and the actual drawing or DOM geometry. It does not prove identical rasters, intermediate retention, GPU completion or physical presentation.
- WebGL cells use a 560 × 456-pixel drawing buffer at DPR 2 for both libraries. DOM cells use a normalized 360 × 288 CSS-pixel surface, a 15px font and hidden scrollbars.
- One Unicode line per tick on WebGL has energy lower and instructions higher in both pairs. The review records the instruction ratio as a loss. DOM typing-like edits have mixed pairs on both metrics.
- DOM one Unicode line per tick is unavailable. xterm.js DOM produced two different settled screenshots within the same actor in both attempts, so the equal-output check failed. The retry also repeated DOM windows that had already passed their checks. Neither attempt feeds a number.
- Counter coverage uses stable endpoint PID, type and start identities. Entirely transient processes can escape that coverage. Sequential samples are non-atomic. Counters end after reset, writes, two animation frames and work snapshots, so the result proves logical settlement and not physical presentation.

## Recompute without a browser

From the ghostty-webgpu checkout, use Node 22 or newer.

```sh
node docs/benchmarks/mac-m1-2026-10-10/verify.mjs
node docs/benchmarks/mac-m1-2026-10-10/report.mjs --check
```

The verifier recomputes all nine ratios and their pairs from saved per-process counter deltas, checks equal output digests and public write counts, and compares the result with the review cell. The report check compares the public benchmark page and README table with the same score file. To publish a score revision, update its evidence and review first, then run `report.mjs` without `--check`.

## Not included

This set has no reproduction package. The frozen browser bundles and drivers for these runs stay in the private acquisition, identified by the protocol hashes in each counter record. The 2026-10-08 set keeps a reproduction package for its own frozen runtime.
