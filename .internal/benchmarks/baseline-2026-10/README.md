# PC and M1 baseline packet

Measured on 2026-10-27. Runtime source is `d2ed8989a745f016188e0a2e749009b3e1450f33`, the main revision at acquisition. These are experimental controls for Phase 1, with two repetitions per baseline case. They are not speedup claims.

- [Baseline stages and counts](baseline.csv): both hosts, WebGPU and WebGL2, 200×50 and 80×24, DPR 2, 60 paced updates after 10 warmup updates, two backend-counterbalanced repetitions. All ten requested workloads are present.
- [Mac energy and instructions](energy.csv): calibrated `proc_pid_rusage` with `RUSAGE_INFO_V6`, using the existing native reader. Each row names its process family. CPU energy excludes GPU-device and display energy.
- [Completion and GPU passes](completion.csv): queue completion and timestamp-query render-pass duration are separate endpoints.
- [Main and worker entries](hosted.csv): production API entry, WebGPU, ABBA order, 200×50, DPR 2, six workloads. Acknowledgement is not presentation.
- [Observer controls](overhead.csv): trace off/on/on/off in one browser per host, both backends, three workloads. No overhead correction is applied.
- [Machine-readable packet](summary.json), [endpoint notes](endpoints.md), and [reproduction](reproduce.md). Unresolved channels remain named in the notes.

The PC is the i7-14700K with RTX 3060 Ti, Linux, Chromium 153.0.8010.12. The Mac is the M1 MacBook Air, macOS, the same Chromium version, hardware Metal adapter, AC power. Exact OS release, adapter, expanded launch metadata, browser-bundle hashes and wasm hashes are in the packet and raw records. Mac timings have concurrent host load around 3–4 on eight cores and are experimental. The PC uses the shared quiet runner, retaining the pre-existing gallery service.

`ascii` overwrites the same text at the home position. `rolling-logs` is lane 07a's `burst-output`; `viewport-scroll` is its `sustained-scroll`. NTCharts and OpenTUI replay the study's original captured chunks at the requested viewport sizes. Their captures were authored at 100×30; resizing the terminal does not regenerate the programs. Cold cache explicitly clears the glyph atlas before each update, after ordinary page/font/core startup.

Times are self CPU spans from lane 07a's wrappers, divided by logical updates. Parser calls and logical updates have separate counts. Rolling logs deliver ten lines in one write per update; viewport scrolling issues no writes. Upload bytes are API traffic, not device residency. CPU percentages use one core as 100%; renderer and GPU-process CPU remain separate. Submitted frames count actual renderer submissions. Baseline presented-update counts are unavailable and remain `null`.

The repeated ASCII case submits 120/120 frames on WebGPU and 0/120 on WebGL2 after warmup on both hosts. At 200×50, all-Chrome CPU is 15.7% versus 3.9% on the PC and 35.0% versus 13.1% on the Mac. This is an observation of the identical-output baseline, not a qualified improvement comparison. Text hashes match across both backends in all 40 host/grid/workload groups. Screenshots do not establish cross-backend pixel equality.

Raw evidence is `/work/reports/ghostty-webgpu-next-2026-10/p0a/`. `raw-manifest.json` records hashes. Frozen browser bundles, worker bundles, traces, failed attempts and logs stay there for replay. The small packet contains no production runtime changes.
