# Reproduce F2

The raw packet is `/work/reports/ghostty-webgpu-next-2026-10/f2/`. It retains failed admissions, failed checks, frozen browser bundles, the exact diagnostic harness, all comparison records, screenshots and Chrome GPU traces. The P0a control packet is now on main under `.internal/benchmarks/baseline-2026-10/`.

Use an owned worktree of the F2 branch and a detached control worktree at `5aa4f4326`. Install the frozen lockfile in the candidate and link the control `node_modules` to the candidate. Apply the raw `harness.patch`, then this directory `gpu-trace.patch`, to the candidate. The patch adds diagnostics only; production runtime files remain those of the selected source. The measured production implementation is `ec2c3c8d594928cda01adc32281c15bcbbc0b2df`. Later changes align test layout and record evidence.

`run-pairs.sh HOST OUT WORKLOADS CONTROL` runs the matrix. `WORKLOADS` is the P0a raw `workloads` directory. Each primary ASCII cohort uses four repetitions, 120 paced writes after ten warmup writes, both GPU backends and DPR 2. Source and backend order reverse on alternating repetitions. The broader M1 matrix uses two repetitions and 60 updates. Results remain experimental.

On the PC, acquire a separate shared quiet reservation for each grid/count combination, with `F2_GRID=80x24|200x50` and `F2_COUNT=1|16`. The default PC invocation runs 80×24 with one terminal. `F2_PHASE=extras` runs GPU-process traces, a repeated-output trace, Unicode screenshots and hardware tests. These windows stay below the runner ten-minute quiet limit. Before the hardware tests, build `dist` in the candidate. Every headed browser checks for at least 2 GiB free VRAM and closes between cohorts.

On the Mac, use the fleet availability check and atomic lock. The original matrix ran in one reservation. After the readback fix, a separate source-matched final ASCII matrix ran at all four grid/count combinations. The manifest checked all 301 source/runtime files before that final acquisition. The Mac lock was released between runs for the coordinator handoff; no running cohort was interrupted.

Run the checks from the F2 checkout:

```sh
UV_CACHE_DIR=/work/cache/uv uv run --no-project --with ijson --with pillow python .internal/reference-study-2026-10/f2/summarize.py /work/reports/ghostty-webgpu-next-2026-10/f2
python3 .internal/reference-study-2026-10/f2/gpu-attribution.py /work/reports/ghostty-webgpu-next-2026-10/f2
```

The streaming analyzer checks paired text hashes, bytes, parsed calls, acknowledgements and pending frames. It compares all RGBA screenshot bytes. Primary receipts are `repeated-output.csv`; `all-workloads.csv` keeps every acquired case. Raw `summary.json` also retains per-repetition work counts.

Submitted counts are actual renderer submissions. Parsed calls are native parser calls. Primary presented-update counts are unmeasured. The separate PC Chrome trace records whole-page swaps, including 120 swaps before and zero after the repeated-output change. It does not measure physical scanout or input latency. Trace scope durations are inclusive and cannot be summed across nested scopes.
