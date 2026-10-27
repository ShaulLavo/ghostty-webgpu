# Reproduce this packet

The measurement data shape is one record per host, backend, grid, workload, repetition and entry. Aggregates retain logical updates, parser calls, submissions and separate timing endpoints. `summarize.py` is the rerunnable check and exporter. It asserts 80 baseline rows, 400 calibrated Mac process-family energy rows and matching backend text hashes for 40 workload groups.

## Acquisition

Start at `d2ed8989a745f016188e0a2e749009b3e1450f33` in an exclusive worktree. Apply `gzip -dc .internal/benchmarks/baseline-2026-10/harness.patch.gz | git apply -`. It reuses lane 07a's diagnostics, with local timestamp-query, native-counter, worker-heap and input/recovery probes. It changes no production source or wasm. The raw directory retains the original lane 07a patches, intermediate modification scripts and frozen bundles because instrumentation evolved during acquisition. Replay a particular record with that record's frozen bundle, not a newly compiled bundle.

The baseline protocol follows the Feature playbook with direct ownership because the binding brief forbids nested delegation. Architecture exploration is skipped because the existing lane 07a runner is required. The throughput checkpoint is:

- Blocking first steps were host availability, PC free VRAM, native Mac lock and a successful hardware pilot.
- Independent PC and Mac acquisitions ran concurrently; their data directories were separate.
- Shared mutable state was limited to the PC quiet queue and Mac job lock, both held during hardware windows. Local benchmark source updates are reflected in frozen bundle hashes.
- One worker owned the patch, records and exporter, as the binding brief requires.

`run-cohorts.sh` records the full M1 matrix, the trace ABBA controls, completion windows, and main/worker ABBA windows. Its exact PC command was:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
TMPDIR=/work/tmp/ghw-p0a-t bun /work/platform-production/heavy/current/run.js --quiet --class bench 'p0a PC remaining cohorts' -- bash /work/reports/ghostty-webgpu-next-2026-10/p0a/run-cohorts.sh pc /work/reports/ghostty-webgpu-next-2026-10/p0a /work/reports/ghostty-webgpu-next-2026-10/p0a/workloads
```

The initial PC 200×50 stage window used the same environment with `BENCH_SCENARIOS=burst-output,sustained-scroll,cursor-movement,sparse-edit,dense-redraw,glyph-churn,cold-cache`, `BENCH_TRACE=1`, `BENCH_DEFAULT_GPU=1`, `BENCH_STEPS=60`, `BENCH_WARMUP_STEPS=10`, `BENCH_REPETITIONS=2`, `BENCH_SCREENSHOTS=0`. It created fresh pages rather than reusing a page. Other windows used `BENCH_REUSE_PAGE=1`. Each browser closed between cohorts. The initial rejected pilot used the nonexistent scenario name `viewport-scroll`; it failed before browser launch and supplies no measurements.

The Mac ran these commands under the atomic `~/tmp/.agent-mac-lock`, with owner-only availability rechecked after acquisition:

```sh
export PATH=$HOME/.local/share/mise/shims:$HOME/.bun/bin:$PATH
cd ~/tmp/ghw-p0a
bash run-cohorts.sh mac "$PWD/results" "$PWD/workloads"
bash run-additions.sh mac "$PWD/results" "$PWD/workloads"
swiftc display-modes.swift -o display-modes
bun m5.mjs
bash mac-final.sh
```

`run-additions.sh` records separate timestamp-query completion windows and the Mac energy matrix. The timestamp device explicitly requests the optional feature; the ordinary production-default device does not. `mac-final.sh` repeats the command/frame input join after removing a redundant diagnostic `encode` wrapper, attaches to the worker target for `Runtime.getHeapUsage`, and repeats the real-display/tab probe. The Mac source was staged from the PC checkout with the same wasm bytes. Its raw `revision` field is empty because that disposable source copy had no `.git`; the source revision above and retained bundles identify it.

`checks.mjs` runs production WebGPU main/worker entries in order main, worker, worker, main. It reuses `tracePhase` and `presentationLatency` from the existing comparison runner. Each input is a real Playwright key event echoed through the terminal input callback. It checks the echo in submitted text, captures a screenshot, and joins the traced parser/render command to Chrome presentation feedback. The screenshot supplies an upper observation boundary; its time is never substituted for presentation. The raw file records the exact join exception when no frame can be joined.

The early `m5.mjs` attempts used an actual headed browser with no emulated DPR and removes Playwright's three background-throttling overrides. The native CoreGraphics helper enumerates and temporarily selects a real display mode, restoring the original mode in `finally`. It never dispatches a synthetic visibility event or assigns a simulated DPR. The final retained `m5.mjs` launches native Chromium with an explicit remote-debugging port 41879 and connects with `noDefaults:true`; its two failed navigation attempts are retained. Earlier visible-page bundles and screenshots remain in the raw packet.

## Frozen replay

For example, replay the PC baseline browser code with its recorded runtime assets and the matching runner:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
BENCH_PREBUILT_BUNDLE=/work/reports/ghostty-webgpu-next-2026-10/p0a/pc-200x50-stages.candidate.bundle.js BENCH_BACKENDS=webgpu,webgl2 BENCH_DEFAULT_GPU=1 BENCH_TRACE=1 BENCH_COLUMNS=200 BENCH_ROWS=50 BENCH_DPR=2 BENCH_SCENARIOS=burst-output,sustained-scroll,cursor-movement,sparse-edit,dense-redraw,glyph-churn,cold-cache BENCH_STEPS=60 BENCH_WARMUP_STEPS=10 BENCH_REPETITIONS=2 BENCH_SCREENSHOTS=0 BENCH_OUTPUT=/work/reports/ghostty-webgpu-next-2026-10/p0a/replay.json bun /work/platform-production/heavy/current/run.js --quiet --class bench 'p0a frozen replay' -- bun run bench:renderer
```

A worker replay also needs the matching `BENCH_PREBUILT_WORKER` from the raw `.json.worker.js` file. Replays require fresh fleet availability checks, PC VRAM ≥2 GiB and the Mac lock. The renderer runner routes requests without a listening server. The input and display probes bind explicit localhost ports 41878 and 41877 and close them on exit.

## Export

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
python3 .internal/benchmarks/baseline-2026-10/summarize.py /work/reports/ghostty-webgpu-next-2026-10/p0a
```

Build the exporter from raw evidence, including `mac-results/`. `raw-manifest.json` hashes the retained JSON, frozen bundles, traces, screenshots and logs. Native helper calibration and per-process identities are retained in the raw energy records. Native snapshots are sequential and cannot account for a process born and gone between both boundaries.

## Verification environment

Build, typecheck, lint and format checks ran on a clean source archive on the Mac. Its first unit run used macOS's `/var/folders` temporary path and exposed two expected-versus-canonical `/private/var/folders` path mismatches. Moving temporary files under the staged checkout fixed those path comparisons but made an intentionally uninstalled dependency fixture inherit the checkout's `node_modules`. The final unit environment uses a canonical sibling directory, `TMPDIR=$HOME/tmp/ghw-p0a-unit-t`, outside the source tree, and includes `/opt/homebrew/bin` in `PATH`. The failed runs are retained, not reported as product regressions. The PC gate job was withdrawn from the shared queue before it began; the Mac executes the required checks instead.
