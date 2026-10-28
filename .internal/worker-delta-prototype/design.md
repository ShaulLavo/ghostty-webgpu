# Revision-keyed worker publication experiment

Status: Approved research. Lane X4r. This is the bounded successor to X4b's positional deltas, using X7's native text revisions.

The decision is whether revision reuse removes the host row-reconstruction cost that rejected X4b. The candidate sends an ordered native revision list, viewport row indices, summary patch indices, and binary payloads only for revisions absent from its cache. A payload contains exact UTF-16 text, individual cell strings, and continuation flags. Small frame metadata keeps the existing structured clone. The host rewraps cached rows at their current `y` and reconstructs the complete projection and summary.

Each worker has one encoder. Each host execution has one decoder. Both caches retain only the current and previous revision lists. Older snapshots keep their own frozen arrays and row objects. Revision zero and mismatched revision/row counts are errors.

The control is the unchanged worker on the same source. Only the candidate switches its renderer observer to X7 retained displayed text, reads native revision lists, and uses revision transport. Requests, acknowledgements, errors, links, selection operations, native events, and renderer topology stay on their existing paths. Both arms have one worker, runtime, and direct renderer context per terminal.

## Fixed cohort

One cohort, with no tuning reruns. Three workloads (`mixed-edit`, `sustained-logs`, and `unicode-varied`), 4 and 16 terminals, 200×50 and 80×24, DPR 2, JetBrains Mono 13, eight warmup steps, sixty measured steps, and two counterbalanced repetitions. A pair shares one browser. Each pair closes its browser before the next pair. Terminal zero writes every step and each sibling writes every fourth step.

Timing runs only on the M1 Mac with headed Chromium, hardware WebGPU, AC power, and the fail-closed agent lock. PC runs are non-quiet and correctness-only. The runner rejects headed timing on other hosts.

All X4b gates apply in every condition:

- Host main-thread task time per delivered frame is at most 50% of control.
- Input bytes, ordering, byte counts, parsed writes, native events, text, decoded pixels, complete snapshots, summaries, delivered frames, and renderer submissions match.
- Busiest-terminal acknowledgement p95 and p99 are at most 1.2× control.
- Worker task time and total resident memory do not regress.

Presentation counts remain unresolved. Renderer submissions come from each renderer's `metrics.submittedFrames`, read through its worker CDP target and ordered by benchmark terminal ordinal. They are not inferred from host callbacks.

## Measurement joins and Mac accounting

The X4b queue, parse-reply, encoding, host-receive, and GC joins remain. Worker CPU uses `ThreadControllerImpl::RunTask` durations on trace threads whose metadata names them `DedicatedWorker`. Nested V8 events are diagnostics and are not added to this total. The receipt retains the event-name breakdown. This is worker task time, not whole-renderer CPU.

Total resident memory is the sum of `proc_pid_rusage/RUSAGE_INFO_V6` `ri_phys_footprint` over the Chrome process family. Every live worker also reports V8 used heap, embedder heap, and backing storage through CDP. Worker heap is a separate diagnostic and is not added to physical footprint again. GPU-device allocations are not separately exposed by this Mac endpoint. Transport does not change renderer resources.

## Throughput checkpoint

- [x] Blocking first steps. Trace native revisions, preserve complete rows, and pass a native-backed headless parity run before hardware timing.
- [x] Independent workstreams. No delegation, as required by the binding brief. Static checks and browser checks use separate heavy-runner jobs.
- [x] Shared mutable state. Encoder and decoder caches are per terminal. Each paired sample closes its pages and browser.
- [x] Smallest safe decomposition. Build-time adapters add revision access and instrumentation. Production source stays unchanged.

## Cleanup ownership

The runner creates browser processes, disposable profiles, pages, workers, CDP connections, one native counter helper per browser, JSON receipts, and PNG screenshots. It creates no server, route, container, or downloaded payload. Browser, counter-reader, and scratch cleanup runs on success or failure. Raw review evidence stays in `/work/reports/ghostty-webgpu-next-2026-10/x4r-revision-deltas/` for coordinator review.
