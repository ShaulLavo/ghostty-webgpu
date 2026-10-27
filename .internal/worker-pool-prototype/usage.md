# Worker pool experiment reproducer

This code is a throwaway X4/E6 instrument on `research/worker-pool`. It does not change the package entry points.

The control uses `WorkerTerminalExecution` and `TerminalWorkerRuntime` from the checked-out source. The build adds a timer around host frame reception. It keeps the existing frame clone and readonly restoration.

The pool borrows one `GhosttyRuntime` across all sessions. One WebGL2 context owns separate framebuffer targets and per-session renderer resources. Each submitted image is copied to the session's display canvas. The owner forwards context loss and restoration to all surviving sessions. This copy is part of the measured cost. The experiment does not share font atlases or pipelines.

A binary publication has an eight-byte header, then twelve bytes per changed row and UTF-8 text payload. The host replaces changed rows. The prototype transports text only. A production protocol also needs cell boundaries, continuation flags, cursor/layout identity, selection, and links. Passing this prototype's gates would not qualify those omitted capabilities.

Run from the research worktree on the PC with no other headed benchmark browser. Check owner availability and at least 2 GiB free VRAM. The runner checks VRAM again before every browser.

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
bun /work/platform-production/heavy/current/run.js --class bench --quiet 'X4 paired hardware' -- env WORKER_POOL_STEPS=60 WORKER_POOL_REPETITIONS=2 WORKER_POOL_OUTPUT=/work/reports/ghostty-webgpu-next-2026-10/x4-worker-pool/hardware.json bun scripts/worker-pool-benchmark.ts
```

The harness closes every browser in `finally`. It creates no dev server. Request interception serves the page on port 41807; only the browser's loopback debugging endpoint listens on port 41808. It attaches to each live worker target using flattened CDP and reads `Runtime.getHeapUsage`. Linux dedicated-worker thread ticks are read before and after the sample at the host's 100 Hz clock rate. Browser process PSS includes worker isolates; heap values are reported separately and are not added to PSS again.

`TaskDuration` includes all main-thread work in the sample, including message deserialization and sample orchestration. The receive-handler timer excludes deserialization but includes readonly restoration in the control. Report both. Acknowledgement is parser acceptance, separate from frame publication. Each update waits for its frame before the next update, and terminal zero receives four times as many updates as its siblings.

The fixture keeps geometry and DPR fixed and uses ASCII, wide text, combining accents, an overhanging mathematical italic glyph, and a color emoji. It does not substitute for the full L6 workload cohort. PNG and text hashes must match before treating timings as a performance comparison. Browser startup and heap/screenshot probes are outside the timed sample. Order is control/pool, then pool/control. Each arm uses a fresh browser to release contexts and isolate memory.
