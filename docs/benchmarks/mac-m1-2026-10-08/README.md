# Reviewed M1 terminal measurements

Published 2026-10-08 from the terminal performance wave's reviewed round-1 scoreboard. The windows ran on 2026-10-07 UTC. The publication adds no hardware runs and makes no claim about current main.

[Public comparison page](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks.md) · [Scores](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-08/scores.json)

## What is saved

`scores.json` contains only the nine independently reviewed WebGL and DOM rows. Each row links its counter record, frozen capsule and review. Unreviewed Canvas, WebGPU, Pi and later candidate observations are omitted. The historical full-stream WebGL wins are omitted in favor of the reviewed bounded-history condition.

The source is ghostty-webgpu 0.3.20 at Fregat commit `902687697db8a58a211495d07f4938d331feef92`, paired with xterm.js 6.0.0 and WebGL addon 0.19.0. The bundled font is JetBrains Mono 5.3.0. The machine is an Apple M1 MacBook on AC power, running headed Chrome 154.0.8037.93 with hardware ANGLE Metal rendering. This saved acquisition does not include a separate OS-build receipt. Browser, source and runtime hashes identify the measured software.

Each workload has 17 visible 40 × 12 terminals at DPR 2, 120 warm-up ticks and 900 measured ticks paced at 60 Hz. Runs alternate in balanced adjacent pairs. WebGL and DOM rolling logs have four pairs; other DOM workloads have two. The result is the median of each pair's ghostty/xterm ratio. It is not a ratio of separately calculated medians.

Energy means macOS's kernel estimate of process CPU energy across the Chrome process family. Instructions are retired CPU instructions across those same processes. GPU-process CPU work is included. GPU-device and display energy are outside the measurement. CPU seconds are saved for context; pre-October-7 efficiency verdicts based only on CPU seconds are superseded.

The JSON counter records are compact copies of the original indexes. They preserve per-PID native deltas, aggregate channels, work counters, output hashes, final retained rows, geometry, times, and original index/protocol hashes. Large repeated text arrays, endpoint snapshots and PNG payloads are omitted. The original index hash identifies the complete private acquisition; the compact copy cannot replace it for every possible audit. Independent review JSON files retain their numerical evidence and qualifications, with private paths removed.

The frozen browser assets are compressed under `reproduce/assets/`. Five measurement configurations share three distinct browser bundles and common assets. `assets.json` records archive and asset hashes, original manifest/seal hashes, and the original driver hash. Runtime files retain their original bytes. The assets directory includes the Ghostty, ghostty-web and xterm.js licenses; the common archive carries the font license. The measured native engine uses Ghostty revision `7b11f3dca034d8d24369ad3856afe57946d7902a`. The publication changes the scripts' input/output paths, Playwright resolution and Python-reader location, while preserving each configuration's measurement body.

## Review limits

- WebGL rolling workloads match final retained text and 8,841 history rows. Native page-granular eviction uses a nominal 10,000-row limit and a 64 MiB byte budget. xterm.js uses an exact 8,841-row cap. Intermediate history differs. Unicode lacks a Mac history trajectory.
- DOM rolling logs use full-stream history and default surfaces. The xterm grid is about 3% wider and includes scrollbar rasters. DOM Unicode also has different emoji composition. These are text-equivalent default-terminal observations.
- DOM scrolling and edits use 360 × 288 CSS-pixel grids, a 15px font and hidden scrollbar rasters. The remaining rows use the default 12px font.
- Observer calibration supports a limited rolling-log comparison. It does not prove zero overhead or cross-workload equivalence. The small DOM workloads have two pairs and uncalibrated observer overhead.
- Counter coverage uses stable endpoint PID/type/start identities. Entirely transient processes can escape that coverage. Sequential samples are non-atomic.
- Counters end after reset, writes, two animation frames and work snapshots. Text and screenshot capture follow. This proves logical settlement, not physical presentation.
- The reviews qualify local instrumented whole-terminal comparisons with limits. They do not establish universal renderer speed, physical-device energy savings or cross-session confidence intervals.

## Recompute without a browser

From the ghostty-webgpu checkout, use Node 22 or newer.

```sh
node docs/benchmarks/mac-m1-2026-10-08/verify.mjs
node docs/benchmarks/mac-m1-2026-10-08/report.mjs --check
```

The verifier recomputes all nine ratios from saved per-process counter deltas, checks equal logical output and public write counts, and verifies frozen archive hashes. The report check compares the public benchmark page and README table with the same score file. To publish an accepted score revision, update its evidence and reviews first, then run `report.mjs` without `--check`.

## Reproduce a frozen measurement

This opens a separate headed browser with an ephemeral profile. It never uses an existing Chrome profile. Each workload takes several minutes. Actual acquisition requires macOS with `RUSAGE_INFO_V6`, Python 3, tar, Node 22 or newer, AC power, a visible display, a quiet host and the recorded Chrome version. The scripts reject other platforms and browser versions. No OS-specific tool is needed for offline verification.

Install the pinned tool dependency locally. No global package changes are needed.

```sh
npm install --prefix docs/benchmarks/mac-m1-2026-10-08/reproduce --ignore-scripts
```

Choose a new output directory and an explicit free loopback port. Supply the Chrome executable for your installation. The example uses a caller-owned temporary directory and deliberately requires `CHROME_EXECUTABLE` to be set.

```sh
: "${CHROME_EXECUTABLE:?Set the path to Chrome 154.0.8037.93}"
parent=$(mktemp -d "${TMPDIR:-/tmp}/ghostty-reviewed-XXXXXX")
node docs/benchmarks/mac-m1-2026-10-08/reproduce/run.mjs \
  --case webgl-bounded-logs --output "$parent/run" \
  --browser "$CHROME_EXECUTABLE" --port 49199
node docs/benchmarks/mac-m1-2026-10-08/verify.mjs \
  "$parent/run/tw-webgl-capped-rolling-logs-r01/index.json"
```

Case names are `webgl-bounded-logs`, `webgl-bounded-unicode`, `webgl-unicode`, `webgl-scroll`, `webgl-edits`, `dom-logs`, `dom-unicode`, `dom-scroll`, and `dom-edits`. Use one new output directory per case. Saved IDs select the original registered workload; a new run has a new session ID, timestamp, protocol hash and adapter receipt. Keep every valid window. Keep a rejected acquisition under its own identity and register any replacement before running it.

For a preparation-only check on Linux or macOS, add `--prepare-only` and omit `--browser`. It verifies and extracts the frozen inputs without opening a browser or collecting counters.

A rerun uses the frozen historical runtime. It does not measure current main, retroactively extend the independent review, or automatically qualify a new public number. Current-main runs require a newly registered protocol, equal-work checks and independent review. The terminal performance wave owns the next Mac session.

## Fresh measurements

Current-main WebGL and DOM need all five workloads with equal bounded history and its trajectory recorded. Canvas needs reviewed like-for-like pairs. WebGPU needs reviewed own-control measurements and separately labeled cross-API comparisons. Parser throughput needs a current run.

Whole-browser memory and presentation latency have no current headline here. Memory must include resident WASM in the browser process-family totals, with idle and matched-history baselines. Do not add WASM capacity to RSS. Plan 283 retired the October 1 screencast latency rows; a new presentation-clock protocol needs at least 100 samples per case at 1 and 17 terminals.
