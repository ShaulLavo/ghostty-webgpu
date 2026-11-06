# Bounded queue probe

Run `bun run build && bun run bench:queue`. Set `QUEUE_PROBE_OUTPUT` to retain the JSON outside `.artifacts`. The default uses headless Chromium and SwiftShader. It tests queue behavior, not hardware speed. `GHOSTTY_BROWSER_HARDWARE=1` uses headed Chromium; take the normal host reservation and hardware checks first.

The probe offers 64 KiB ASCII chunks through the shipped `writeBatched` API in the main and worker entries. Each chunk ends with a device-status query. Its native reply independently counts a completed parse. Promise settlement counts acknowledgements or explicit queue-limit rejections. Actual `GPUQueue.submit` calls are counted separately from frame callbacks. Worker submission notices add observer overhead.

Both entries use one explicit font, 200 columns and 50 rows, and an emulated DPR of 2. The supported queue configuration is an 8 MiB limit and a 4 ms batch budget. Requested rates and actual production duration are retained, so the achieved rate can be calculated rather than assumed from the timer request.

Production stops at 750 ms or 64 MiB attempted per point. Drain has a 15 second deadline. A 120 second controller bound closes the browser. Each context and browser is closed on failure too. An input event uses the normal synchronous local-echo path, which flushes older batched output. Keydown-to-acknowledgement and event-loop heartbeat delays are not presentation latency.

Pending bytes are sampled before and after each producer task. A newly enqueued burst does not prove overload. The analyzer requires residual backlog across later tasks, observed growth, native parse progress, settled promises and a drained final queue. It rejects missing submission and responsiveness controls. A saturated queue may explicitly reject offers; those attempts stay in the counts.

`bench/write-queue-probe.test.ts` is explicitly included in the Node Vitest project and therefore in CI's `test:unit` command. Its negative controls include a recurring enqueue burst that drains before each next offer. The benchmark does not supply M2 worker presentation identity, real visibility or DPR observations, memory peaks or X8 GPU-time attribution.
