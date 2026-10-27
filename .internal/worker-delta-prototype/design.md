# Delta-only experiment design

Status: Approved. Lane X4b. The fixed protocol is the "Delta-only follow-up" section of PR #17, commit `20055add`.

The worker parser owns native state. `TerminalWorkerRuntime.submitFrame` submits that state and sends a complete snapshot and summary through its message port. `WorkerTerminalExecution.receive` restores frozen ownership before invoking the frame listener. Acknowledgements and session events use the same FIFO port. The experiment changes only frame transport between these boundaries.

The binary packet contains changed rows with exact UTF-16 text, individual cell strings, and continuation flags. Each row has its own index and lengths. The small snapshot and summary metadata use the existing structured clone. Ordered row indices reconstruct the complete snapshot and summary. Patch indices retain the summary's changed-row observer data. Encoder state belongs to one worker; decoder state belongs to one terminal identity. Old snapshots retain their frozen rows.

Two alternatives were considered. Reusing the pooling sketch's row-text packet would omit cells and continuation flags, so it cannot qualify. Replacing the complete public API with binary messages would mix command/event changes into the experiment. The chosen packet changes frame rows while leaving requests, acknowledgements, errors, links and native selection operations on their current paths.

The experiment deliberately retains worker-side full-row materialization and comparison. Its CPU and memory cost count against the candidate. A future native changed-row encoder would be a different candidate, requiring its own measurements.

## Throughput checkpoint

- [x] Blocking first steps. Read the fixed protocol and trace publication. Validate full-frame roundtrips and text/pixel parity before hardware measurement.
- [x] Independent workstreams. No delegation, as required by the binding brief. Static checks can wait separately from browser work in the shared runner.
- [x] Shared mutable state. Each worker has its own encoder. The host keys decoder state by terminal identity. Each paired sample closes its pages and browser.
- [x] Smallest safe decomposition. One owner maintains codec, boundary instrumentation and runner together. There is no production source change.

## Measurement joins

Each worker message records terminal identity, control watermark, queue arrival, execution start, publication/encoding start, encoding end, and host receive/completion. Frame messages also record frame identity. A reply with the same terminal/control is the parser acknowledgement. Times use `performance.timeOrigin + performance.now()` in both realms. The publication-to-host interval includes message serialization, transport and scheduling, which this probe cannot separate.

Chromium GC trace events retain process/thread identity and trace timestamps. A clock-sync marker and surrounding epoch readings connect the trace clock to the message timestamps. All live worker CDP targets report their identity and heap. Worker CPU is the existing Linux dedicated-thread tick endpoint. Memory is Chrome-family PSS plus device-VRAM growth from the pair's pre-browser baseline.

Parsed writes and delivered host callbacks are counted separately. Renderer submissions are not independently measured: the historical `submittedCounts` field is derived from delivered callbacks. New receipts leave `submittedCounts` unresolved and label the inferred values explicitly. The summary does not treat that derived field as an independent check. The sample waits for a frame after every scheduled write. A delivered frame is not a compositor presentation receipt. Presented counts remain explicitly unresolved; decoded screenshots verify the final pixels.

## Cleanup ownership

The runner creates browser processes, browser-owned temporary profiles, pages, workers, CDP connections, JSON receipts and PNG screenshots. It creates no dev server, deployment, container, route or downloaded payload. Browser/page `finally` blocks close consumers on success or failure. The task owner removes the exclusive worktree after pushing. Raw review evidence stays in `/work/reports/ghostty-webgpu-next-2026-10/x4b-binary-deltas/` for coordinator review.
