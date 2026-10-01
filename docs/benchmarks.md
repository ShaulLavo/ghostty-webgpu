# Terminal comparison benchmarks

Generated from the checked-in JSON artifact. Lower is better except parse throughput.

## Run it

From `ghostty-webgpu`, run `bun run bench:compare -- --bundle /path/to/bundle` to build and measure.
Use `bun run bench:compare -- --smoke --bundle /path/to/bundle` for correctness only.
Use `bun run bench:compare -- --build-only --bundle /path/to/bundle` for a portable Node bundle.
On the target machine, enter that bundle and run `npm install --ignore-scripts`,
`npx playwright install chromium`, then `node comparison-runner.mjs --smoke`.
Run `node comparison-runner.mjs --output results` on AC power for measurements.
Headed Chromium windows open during the run. Set aside up to 30 minutes.
Regenerate the checked-in report with `node scripts/comparison-report.mjs docs/benchmarks/mac-m1/comparison.json docs/benchmarks.md docs/benchmarks/mac-m1/review.json`.

## Environment

- Commit measured: `6ef1784098e23844b85a853e2df88610e3db0567`. Source SHA-256: `3d71e0f1d7698726cb5ead0242116852a71da9da43b296011f38594d6f60d693`.
- Browser: 153.0.8010.12. OS: darwin 25.4.0 arm64.
- GPU: ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Version 26.4 (Build 25E246)). Headed hardware adapter: true.
- Font: JetBrains Mono 5.3.0, bundled regular/bold Latin faces. Emoji and CJK use the same OS fallback fonts.
- Font size: 12px. DPR: 2. Grid: 40 × 12.
- Libraries: ghostty-webgpu 0.2.0; xterm 6.0.0 with WebGL addon 0.19.0; ghostty-web 0.4.0.
- Repetitions: 3. Each table cell is the median of the per-run result, including per-run p50/p95.
- Artifact: [comparison.json](benchmarks/mac-m1/comparison.json).

## Method

Each case opens a fresh browser context. All 1, 8, or 17 terminals remain visible in a fixed grid.
Library order alternates forward/reverse between repetitions and rotates on the third repetition.
Byte/string paths alternate too. A warmup precedes each timed operation.
Chromium launches with a device scale of 2 so resize-observer backing pixels agree with DPR.
Its WebGL context limit is 32 for every case, allowing all 17 xterm WebGL terminals to remain live.
Parse throughput uses unopened parsers and complete UTF-8 corpora in 4 KiB chunks.
Parser-only contexts run before any rendered terminal is created. Timing covers synchronous input decoding/encoding, VT parsing, and buffer writes.
xterm uses its pinned 6.0.0 input-handler parse boundary, bypassing WriteBuffer timers; both Ghostty libraries use synchronous core writes.
A parser returning asynchronous work is rejected. No callback, microtask, or timer wait is included in isolated-parser timing.
After timing, the same instance must match independent expected viewport text, cursor, and SGR color/style probes. Unqualified samples are excluded.
Qualification covers the final viewport and cursor; the alternate screen keeps no offscreen history. Separate one-byte smoke diagnostics are retained even when 4 KiB results qualify.
Text comparison permits NFC composition and trailing blank cells only; ZWJ characters must be retained. Smoke checks exercise both 4 KiB and one-byte chunks.
Empty decoded chunks and an empty final decoder flush are omitted; a nonempty final flush remains part of the input.
Each parse-only fixture owns a fresh WASM runtime. Runtime construction is outside timing for both Ghostty libraries.
Every parse-only terminal enters the alternate screen before timing, so history allocation does not affect parser throughput.
The string chunks are decoded before timing. String-to-WASM encoding remains inside the timed library call.
MB means 1,000,000 bytes. The real-log fixture is an archived 256-entry public Git history log, repeated to at least 1 MiB.
xterm DOM and WebGL share a parser; their parse results are independent repetitions of that same parser.

Write latency starts at the browser write call. Input latency starts at the captured keydown event,
crosses a loopback WebSocket byte echo, and ends at a compositor capture containing the colored glyph.
Chromium screencast timestamps identify the first captured frame showing the glyph, not a library render callback.
This is captured-frame latency, not an optical display measurement. Capture overhead and capture cadence remain in the measurement.
Screencasting is stopped for burst, CPU, and memory measurements.

Burst output writes at least 4 KiB per terminal per animation frame for each corpus.
Every library uses exactly one shared animation-frame pacing wait per iteration. The synchronous ghostty-web public write receives no presentation callback.
Frame intervals come from requestAnimationFrame timestamps. Dropped frames are inferred from the measured idle refresh period,
rounded to the nearest number of display intervals. They are missed animation-frame opportunities, not GPU presentation counters.
CPU sums Chromium process CPU time, including browser, renderer, and GPU, as a percentage of one core. Samples reject any process birth or exit.
Every case has a 120-second deadline capped by the remaining 30-minute window; timeout closes its contexts and retains the failure.
Bundle and asset hashes are verified before serving; both font weights are loaded and checked before rendered phases.
Successful latency phases retain metadata and colored-glyph classification for every screencast frame, including frames that did not qualify a sample.
Failed latency phases retain the last capture image/metadata and a direct screenshot; their partial capture stream is not serialized.

Memory per terminal and per 10k rows is the post-GC CDP used JS heap plus backing storage delta, divided by terminal count.
Output memory is sampled after the 60-frame ASCII output phase, outside CPU timing. Initial memory is the idle baseline.
This is retained JS/backing storage, not total terminal memory. WASM linear-memory capacity is reported separately.
Renderer/GPU RSS deltas cover all Chromium processes and include browser allocation noise and shared resources.
GPU allocation is not available per terminal. Negative deltas are retained as measurement noise.
Each Ghostty library shares one WASM runtime per context, matching its supported multi-terminal use.
The 10k fixture contains exactly 10,000 retained 40-column ASCII history rows per terminal.
The native adapter sets upstream SCROLLBACK_MAX_BYTES to 64 MiB through the runtime ABI, in addition to the 10k line limit.
The session API exposes the line limit only; the adapter checks its pinned internal terminal before applying the byte option.
The default byte budget retained only 2,014 rows in the initial attempt. The final run asserts all 10k rows.
ghostty-web also receives a 64 MiB budget: its 0.4.0 scrollback option is passed to the upstream max_scrollback byte field.
At scrollback: 10000, it retained only 1,852 rows. Its pinned [patch](https://github.com/coder/ghostty-web/blob/9e4e126d/patches/ghostty-wasm-api.patch) documents that option as lines.
xterm has a 10k row limit. Burst phases clear history first; legacy retention is byte-budget-only.

## Results

### 1 terminal, bytes

| Measure                  |  ghostty-webgpu |     xterm WebGL |       xterm DOM | ghostty-web |
| ------------------------ | --------------: | --------------: | --------------: | ----------: |
| parse/ascii              |     164.36 MB/s |      63.55 MB/s |      68.00 MB/s |  65.58 MB/s |
| parse/sgr                |      85.57 MB/s |      63.32 MB/s |      61.56 MB/s |  35.87 MB/s |
| parse/unicode            |      93.13 MB/s |      71.75 MB/s |      73.87 MB/s |  55.36 MB/s |
| parse/cursor             |     166.19 MB/s |      67.94 MB/s |      67.78 MB/s |  56.96 MB/s |
| parse/logs               |     360.42 MB/s |      69.67 MB/s |      69.58 MB/s |  65.71 MB/s |
| write/p50                |        14.03 ms |         8.20 ms |        11.86 ms |  unmeasured |
| write/p95                |        16.84 ms |        18.72 ms |        17.16 ms |  unmeasured |
| input/p50                |        32.06 ms |        30.46 ms |        30.49 ms |  unmeasured |
| input/p95                |        46.19 ms |        32.13 ms |        38.29 ms |  unmeasured |
| burst/ascii/p50          |        16.67 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/ascii/p95          |        17.99 ms |        18.47 ms |        18.49 ms |  unmeasured |
| burst/ascii/dropped      |     0.00 frames |     0.00 frames |     0.00 frames |  unmeasured |
| burst/sgr/p50            |        16.66 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/sgr/p95            |        18.66 ms |        18.47 ms |        18.50 ms |  unmeasured |
| burst/sgr/dropped        |     1.00 frames |     0.00 frames |     0.00 frames |  unmeasured |
| burst/unicode/p50        |        16.66 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/unicode/p95        |        18.58 ms |        18.70 ms |        17.61 ms |  unmeasured |
| burst/unicode/dropped    |     0.00 frames |     0.00 frames |     0.00 frames |  unmeasured |
| burst/cursor/p50         |        16.67 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/cursor/p95         |        18.60 ms |        18.63 ms |        18.68 ms |  unmeasured |
| burst/cursor/dropped     |     0.00 frames |     1.00 frames |     0.00 frames |  unmeasured |
| burst/logs/p50           |        16.68 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/logs/p95           |        18.49 ms |        18.30 ms |        18.51 ms |  unmeasured |
| burst/logs/dropped       |     0.00 frames |     0.00 frames |     0.00 frames |  unmeasured |
| idle/cpu                 |     7.34 % core |    14.36 % core |    13.91 % core |  unmeasured |
| output/cpu               |    30.38 % core |    31.47 % core |    33.68 % core |  unmeasured |
| memory/terminal          |        0.74 MiB |        1.18 MiB |        0.70 MiB |  unmeasured |
| memory/10k               |        0.40 MiB |        7.30 MiB |        7.32 MiB |  unmeasured |
| memory/output/terminal   |        2.66 MiB |        8.90 MiB |        8.39 MiB |  unmeasured |
| memory/initial/wasm      |  1.50 MiB total |  0.00 MiB total |  0.00 MiB total |  unmeasured |
| memory/initial/rss-delta | 28.06 MiB total | 35.53 MiB total | 16.66 MiB total |  unmeasured |
| memory/history/wasm      |  5.06 MiB total |  0.00 MiB total |  0.00 MiB total |  unmeasured |
| memory/history/rss-delta | 43.63 MiB total | 52.41 MiB total | 35.72 MiB total |  unmeasured |
| memory/output/wasm       |  7.13 MiB total |  0.00 MiB total |  0.00 MiB total |  unmeasured |
| memory/output/rss-delta  | 20.19 MiB total | 69.36 MiB total | 73.36 MiB total |  unmeasured |

### 1 terminal, string

| Measure                  |  ghostty-webgpu |     xterm WebGL |       xterm DOM | ghostty-web |
| ------------------------ | --------------: | --------------: | --------------: | ----------: |
| parse/ascii              |     167.24 MB/s |      65.66 MB/s |      66.64 MB/s |  61.97 MB/s |
| parse/sgr                |      80.17 MB/s |      57.89 MB/s |      59.04 MB/s |  35.37 MB/s |
| parse/unicode            |      82.34 MB/s |      79.26 MB/s |      79.62 MB/s |  51.81 MB/s |
| parse/cursor             |     148.11 MB/s |      61.85 MB/s |      61.96 MB/s |  54.23 MB/s |
| parse/logs               |     268.27 MB/s |      65.35 MB/s |      64.93 MB/s |  61.48 MB/s |
| write/p50                |        11.35 ms |        10.60 ms |        12.48 ms |  unmeasured |
| write/p95                |        21.27 ms |        20.20 ms |        19.98 ms |  unmeasured |
| input/p50                |        32.05 ms |        30.05 ms |        30.83 ms |  unmeasured |
| input/p95                |        48.69 ms |        48.26 ms |        48.21 ms |  unmeasured |
| burst/ascii/p50          |        16.66 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/ascii/p95          |        17.78 ms |        18.52 ms |        17.66 ms |  unmeasured |
| burst/ascii/dropped      |     0.00 frames |     0.00 frames |     0.00 frames |  unmeasured |
| burst/sgr/p50            |        16.66 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/sgr/p95            |        17.56 ms |        18.86 ms |        18.66 ms |  unmeasured |
| burst/sgr/dropped        |     0.00 frames |     0.00 frames |     1.00 frames |  unmeasured |
| burst/unicode/p50        |        16.67 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/unicode/p95        |        18.66 ms |        18.65 ms |        18.55 ms |  unmeasured |
| burst/unicode/dropped    |     0.00 frames |     0.00 frames |     0.00 frames |  unmeasured |
| burst/cursor/p50         |        16.66 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/cursor/p95         |        18.65 ms |        17.66 ms |        18.40 ms |  unmeasured |
| burst/cursor/dropped     |     0.00 frames |     0.00 frames |     0.00 frames |  unmeasured |
| burst/logs/p50           |        16.67 ms |        16.67 ms |        16.67 ms |  unmeasured |
| burst/logs/p95           |        18.65 ms |        18.65 ms |        19.17 ms |  unmeasured |
| burst/logs/dropped       |     0.00 frames |     0.00 frames |     1.00 frames |  unmeasured |
| idle/cpu                 |     6.51 % core |    13.32 % core |    14.35 % core |  unmeasured |
| output/cpu               |    32.39 % core |    32.91 % core |    37.01 % core |  unmeasured |
| memory/terminal          |        0.74 MiB |        1.18 MiB |        0.70 MiB |  unmeasured |
| memory/10k               |        0.40 MiB |        7.29 MiB |        7.31 MiB |  unmeasured |
| memory/output/terminal   |        2.66 MiB |        8.89 MiB |        8.39 MiB |  unmeasured |
| memory/initial/wasm      |  1.50 MiB total |  0.00 MiB total |  0.00 MiB total |  unmeasured |
| memory/initial/rss-delta | 29.14 MiB total | 28.14 MiB total |  9.55 MiB total |  unmeasured |
| memory/history/wasm      |  5.06 MiB total |  0.00 MiB total |  0.00 MiB total |  unmeasured |
| memory/history/rss-delta | 42.95 MiB total | 44.41 MiB total | 28.77 MiB total |  unmeasured |
| memory/output/wasm       |  7.13 MiB total |  0.00 MiB total |  0.00 MiB total |  unmeasured |
| memory/output/rss-delta  | 63.05 MiB total | 59.06 MiB total | 62.66 MiB total |  unmeasured |

### 8 terminals, bytes

| Measure                  |   ghostty-webgpu |      xterm WebGL |  xterm DOM | ghostty-web |
| ------------------------ | ---------------: | ---------------: | ---------: | ----------: |
| write/p50                |         12.27 ms |         12.90 ms | unmeasured |  unmeasured |
| write/p95                |         29.19 ms |         19.75 ms | unmeasured |  unmeasured |
| input/p50                |         31.11 ms |         30.55 ms | unmeasured |  unmeasured |
| input/p95                |         40.77 ms |         46.88 ms | unmeasured |  unmeasured |
| burst/ascii/p50          |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/ascii/p95          |         17.17 ms |         16.69 ms | unmeasured |  unmeasured |
| burst/ascii/dropped      |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/sgr/p50            |         16.67 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/sgr/p95            |         16.99 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/sgr/dropped        |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/unicode/p50        |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/unicode/p95        |         17.13 ms |         18.15 ms | unmeasured |  unmeasured |
| burst/unicode/dropped    |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/cursor/p50         |         16.67 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/cursor/p95         |         18.19 ms |         18.23 ms | unmeasured |  unmeasured |
| burst/cursor/dropped     |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/logs/p50           |         16.67 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/logs/p95           |         18.28 ms |         17.79 ms | unmeasured |  unmeasured |
| burst/logs/dropped       |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| idle/cpu                 |      7.33 % core |     17.95 % core | unmeasured |  unmeasured |
| output/cpu               |     58.36 % core |     71.65 % core | unmeasured |  unmeasured |
| memory/terminal          |         0.21 MiB |         0.39 MiB | unmeasured |  unmeasured |
| memory/10k               |         0.27 MiB |         7.02 MiB | unmeasured |  unmeasured |
| memory/output/terminal   |         1.60 MiB |         7.46 MiB | unmeasured |  unmeasured |
| memory/initial/wasm      |   4.94 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/initial/rss-delta |  63.70 MiB total |  47.75 MiB total | unmeasured |  unmeasured |
| memory/history/wasm      |  29.94 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/history/rss-delta | 107.47 MiB total | 136.91 MiB total | unmeasured |  unmeasured |
| memory/output/wasm       |  46.06 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/output/rss-delta  | 111.02 MiB total | 203.33 MiB total | unmeasured |  unmeasured |

### 8 terminals, string

| Measure                  |   ghostty-webgpu |      xterm WebGL |  xterm DOM | ghostty-web |
| ------------------------ | ---------------: | ---------------: | ---------: | ----------: |
| write/p50                |         14.74 ms |         13.68 ms | unmeasured |  unmeasured |
| write/p95                |         22.30 ms |         17.65 ms | unmeasured |  unmeasured |
| input/p50                |         32.09 ms |         30.01 ms | unmeasured |  unmeasured |
| input/p95                |         49.54 ms |         47.42 ms | unmeasured |  unmeasured |
| burst/ascii/p50          |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/ascii/p95          |         17.16 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/ascii/dropped      |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/sgr/p50            |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/sgr/p95            |         18.55 ms |         17.55 ms | unmeasured |  unmeasured |
| burst/sgr/dropped        |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/unicode/p50        |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/unicode/p95        |         17.47 ms |         17.93 ms | unmeasured |  unmeasured |
| burst/unicode/dropped    |      0.00 frames |      1.00 frames | unmeasured |  unmeasured |
| burst/cursor/p50         |         16.67 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/cursor/p95         |         17.48 ms |         18.61 ms | unmeasured |  unmeasured |
| burst/cursor/dropped     |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/logs/p50           |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/logs/p95           |         17.02 ms |         17.43 ms | unmeasured |  unmeasured |
| burst/logs/dropped       |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| idle/cpu                 |      8.09 % core |     18.31 % core | unmeasured |  unmeasured |
| output/cpu               |     59.82 % core |     70.08 % core | unmeasured |  unmeasured |
| memory/terminal          |         0.21 MiB |         0.39 MiB | unmeasured |  unmeasured |
| memory/10k               |         0.27 MiB |         7.02 MiB | unmeasured |  unmeasured |
| memory/output/terminal   |         1.60 MiB |         7.46 MiB | unmeasured |  unmeasured |
| memory/initial/wasm      |   4.94 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/initial/rss-delta |  79.48 MiB total |  59.02 MiB total | unmeasured |  unmeasured |
| memory/history/wasm      |  29.94 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/history/rss-delta | 125.81 MiB total | 147.92 MiB total | unmeasured |  unmeasured |
| memory/output/wasm       |  46.06 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/output/rss-delta  | 168.19 MiB total | 222.38 MiB total | unmeasured |  unmeasured |

### 17 terminals, bytes

| Measure                  |   ghostty-webgpu |      xterm WebGL |  xterm DOM | ghostty-web |
| ------------------------ | ---------------: | ---------------: | ---------: | ----------: |
| write/p50                |         14.44 ms |         12.06 ms | unmeasured |  unmeasured |
| write/p95                |         15.73 ms |         19.09 ms | unmeasured |  unmeasured |
| input/p50                |         32.14 ms |         30.21 ms | unmeasured |  unmeasured |
| input/p95                |         47.38 ms |         47.52 ms | unmeasured |  unmeasured |
| burst/ascii/p50          |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/ascii/p95          |         17.61 ms |         18.65 ms | unmeasured |  unmeasured |
| burst/ascii/dropped      |      0.00 frames |      4.00 frames | unmeasured |  unmeasured |
| burst/sgr/p50            |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/sgr/p95            |         17.61 ms |         18.68 ms | unmeasured |  unmeasured |
| burst/sgr/dropped        |      0.00 frames |      2.00 frames | unmeasured |  unmeasured |
| burst/unicode/p50        |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/unicode/p95        |         17.26 ms |         17.63 ms | unmeasured |  unmeasured |
| burst/unicode/dropped    |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/cursor/p50         |         16.67 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/cursor/p95         |         18.04 ms |         16.68 ms | unmeasured |  unmeasured |
| burst/cursor/dropped     |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/logs/p50           |         16.66 ms |         16.68 ms | unmeasured |  unmeasured |
| burst/logs/p95           |         17.12 ms |         33.33 ms | unmeasured |  unmeasured |
| burst/logs/dropped       |      0.00 frames |     13.00 frames | unmeasured |  unmeasured |
| idle/cpu                 |      9.04 % core |     20.04 % core | unmeasured |  unmeasured |
| output/cpu               |    100.14 % core |     89.89 % core | unmeasured |  unmeasured |
| memory/terminal          |         0.17 MiB |         0.33 MiB | unmeasured |  unmeasured |
| memory/10k               |         0.27 MiB |         6.99 MiB | unmeasured |  unmeasured |
| memory/output/terminal   |         1.51 MiB |         7.34 MiB | unmeasured |  unmeasured |
| memory/initial/wasm      |   9.50 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/initial/rss-delta | 120.38 MiB total |  81.42 MiB total | unmeasured |  unmeasured |
| memory/history/wasm      |  62.13 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/history/rss-delta | 193.64 MiB total | 262.25 MiB total | unmeasured |  unmeasured |
| memory/output/wasm       |  96.31 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/output/rss-delta  | 168.84 MiB total | 277.59 MiB total | unmeasured |  unmeasured |

### 17 terminals, string

| Measure                  |   ghostty-webgpu |      xterm WebGL |  xterm DOM | ghostty-web |
| ------------------------ | ---------------: | ---------------: | ---------: | ----------: |
| write/p50                |         11.32 ms |         13.17 ms | unmeasured |  unmeasured |
| write/p95                |         19.45 ms |         27.07 ms | unmeasured |  unmeasured |
| input/p50                |         32.14 ms |         29.64 ms | unmeasured |  unmeasured |
| input/p95                |         47.99 ms |         46.51 ms | unmeasured |  unmeasured |
| burst/ascii/p50          |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/ascii/p95          |         16.74 ms |         18.63 ms | unmeasured |  unmeasured |
| burst/ascii/dropped      |      0.00 frames |      2.00 frames | unmeasured |  unmeasured |
| burst/sgr/p50            |         16.67 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/sgr/p95            |         16.69 ms |         17.63 ms | unmeasured |  unmeasured |
| burst/sgr/dropped        |      0.00 frames |      5.00 frames | unmeasured |  unmeasured |
| burst/unicode/p50        |         16.67 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/unicode/p95        |         18.60 ms |         16.68 ms | unmeasured |  unmeasured |
| burst/unicode/dropped    |      0.00 frames |      0.00 frames | unmeasured |  unmeasured |
| burst/cursor/p50         |         16.67 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/cursor/p95         |         16.68 ms |         18.58 ms | unmeasured |  unmeasured |
| burst/cursor/dropped     |      0.00 frames |      2.00 frames | unmeasured |  unmeasured |
| burst/logs/p50           |         16.66 ms |         16.67 ms | unmeasured |  unmeasured |
| burst/logs/p95           |         17.36 ms |         50.00 ms | unmeasured |  unmeasured |
| burst/logs/dropped       |      0.00 frames |     12.00 frames | unmeasured |  unmeasured |
| idle/cpu                 |      8.65 % core |     21.28 % core | unmeasured |  unmeasured |
| output/cpu               |     98.19 % core |     86.64 % core | unmeasured |  unmeasured |
| memory/terminal          |         0.17 MiB |         0.33 MiB | unmeasured |  unmeasured |
| memory/10k               |         0.27 MiB |         6.99 MiB | unmeasured |  unmeasured |
| memory/output/terminal   |         1.51 MiB |         7.34 MiB | unmeasured |  unmeasured |
| memory/initial/wasm      |   9.50 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/initial/rss-delta | 108.83 MiB total |  82.06 MiB total | unmeasured |  unmeasured |
| memory/history/wasm      |  62.13 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/history/rss-delta | 195.41 MiB total | 264.45 MiB total | unmeasured |  unmeasured |
| memory/output/wasm       |  96.31 MiB total |   0.00 MiB total | unmeasured |  unmeasured |
| memory/output/rss-delta  | 154.52 MiB total | 293.72 MiB total | unmeasured |  unmeasured |

## Wins and losses

These comparisons use one terminal and the byte path. They report every measured metric against both other libraries.
Win/loss labels describe the observed medians; they carry no statistical-significance claim. Tail latency uses 12 samples per run.

| Measure                  | Against xterm WebGL         | Against xterm DOM           | Against ghostty-web        |
| ------------------------ | --------------------------- | --------------------------- | -------------------------- |
| parse/ascii              | win (164.36 vs 63.55 MB/s)  | win (164.36 vs 68.00 MB/s)  | win (164.36 vs 65.58 MB/s) |
| parse/sgr                | win (85.57 vs 63.32 MB/s)   | win (85.57 vs 61.56 MB/s)   | win (85.57 vs 35.87 MB/s)  |
| parse/unicode            | win (93.13 vs 71.75 MB/s)   | win (93.13 vs 73.87 MB/s)   | win (93.13 vs 55.36 MB/s)  |
| parse/cursor             | win (166.19 vs 67.94 MB/s)  | win (166.19 vs 67.78 MB/s)  | win (166.19 vs 56.96 MB/s) |
| parse/logs               | win (360.42 vs 69.67 MB/s)  | win (360.42 vs 69.58 MB/s)  | win (360.42 vs 65.71 MB/s) |
| write/p50                | loss (14.03 vs 8.20 ms)     | loss (14.03 vs 11.86 ms)    | unmeasured                 |
| write/p95                | win (16.84 vs 18.72 ms)     | win (16.84 vs 17.16 ms)     | unmeasured                 |
| input/p50                | loss (32.06 vs 30.46 ms)    | loss (32.06 vs 30.49 ms)    | unmeasured                 |
| input/p95                | loss (46.19 vs 32.13 ms)    | loss (46.19 vs 38.29 ms)    | unmeasured                 |
| burst/ascii/p50          | win (16.67 vs 16.67 ms)     | loss (16.67 vs 16.67 ms)    | unmeasured                 |
| burst/ascii/p95          | win (17.99 vs 18.47 ms)     | win (17.99 vs 18.49 ms)     | unmeasured                 |
| burst/ascii/dropped      | tie                         | tie                         | unmeasured                 |
| burst/sgr/p50            | win (16.66 vs 16.67 ms)     | win (16.66 vs 16.67 ms)     | unmeasured                 |
| burst/sgr/p95            | loss (18.66 vs 18.47 ms)    | loss (18.66 vs 18.50 ms)    | unmeasured                 |
| burst/sgr/dropped        | loss (1.00 vs 0.00 frames)  | loss (1.00 vs 0.00 frames)  | unmeasured                 |
| burst/unicode/p50        | win (16.66 vs 16.67 ms)     | win (16.66 vs 16.67 ms)     | unmeasured                 |
| burst/unicode/p95        | win (18.58 vs 18.70 ms)     | loss (18.58 vs 17.61 ms)    | unmeasured                 |
| burst/unicode/dropped    | tie                         | tie                         | unmeasured                 |
| burst/cursor/p50         | loss (16.67 vs 16.67 ms)    | loss (16.67 vs 16.67 ms)    | unmeasured                 |
| burst/cursor/p95         | win (18.60 vs 18.63 ms)     | win (18.60 vs 18.68 ms)     | unmeasured                 |
| burst/cursor/dropped     | win (0.00 vs 1.00 frames)   | tie                         | unmeasured                 |
| burst/logs/p50           | loss (16.68 vs 16.67 ms)    | loss (16.68 vs 16.67 ms)    | unmeasured                 |
| burst/logs/p95           | loss (18.49 vs 18.30 ms)    | win (18.49 vs 18.51 ms)     | unmeasured                 |
| burst/logs/dropped       | tie                         | tie                         | unmeasured                 |
| idle/cpu                 | win (7.34 vs 14.36 % core)  | win (7.34 vs 13.91 % core)  | unmeasured                 |
| output/cpu               | win (30.38 vs 31.47 % core) | win (30.38 vs 33.68 % core) | unmeasured                 |
| memory/terminal          | win (0.74 vs 1.18 MiB)      | loss (0.74 vs 0.70 MiB)     | unmeasured                 |
| memory/10k               | win (0.40 vs 7.30 MiB)      | win (0.40 vs 7.32 MiB)      | unmeasured                 |
| memory/output/terminal   | win (2.66 vs 8.90 MiB)      | win (2.66 vs 8.39 MiB)      | unmeasured                 |
| memory/initial/wasm      | 1.50 vs 0.00 MiB total      | 1.50 vs 0.00 MiB total      | unmeasured                 |
| memory/initial/rss-delta | 28.06 vs 35.53 MiB total    | 28.06 vs 16.66 MiB total    | unmeasured                 |
| memory/history/wasm      | 5.06 vs 0.00 MiB total      | 5.06 vs 0.00 MiB total      | unmeasured                 |
| memory/history/rss-delta | 43.63 vs 52.41 MiB total    | 43.63 vs 35.72 MiB total    | unmeasured                 |
| memory/output/wasm       | 7.13 vs 0.00 MiB total      | 7.13 vs 0.00 MiB total      | unmeasured                 |
| memory/output/rss-delta  | 20.19 vs 69.36 MiB total    | 20.19 vs 73.36 MiB total    | unmeasured                 |

## Correctness and limits

The runner asserts ASCII, SGR, wide text, cursor overwrite, byte echo, glyph presentation, and exact history length.
Successful first-repetition correctness checks retain Unicode/ZWJ text and a screenshot.
Review those screenshots for glyph layout differences; parser acceptance alone cannot prove Unicode shaping parity.
Firefox and Safari were not measured. This run qualifies headed Chromium on the recorded hardware only.
The corpus and font hashes, raw latency samples, raw frame intervals, process CPU snapshots, memory buckets,
actual execution order, and failed cases are retained in JSON.
Each validated isolated-parser corpus remains eligible independently of other parser or rendered failures. Other metrics from failed rendered cases are excluded. A metric appears only after three qualified repetitions.

- xterm-dom/bytes/8, repetitions 1: Error: Presented green glyph timed out; latest capture: {"timestamp":1790843230752.5498,"colors":{"red":0,"green":0,"redPeak":0,"greenPeak":0,"width":1600,"height":1400}}
- ghostty-web/bytes/1, repetitions 1, 2, 3: page.evaluate: RuntimeError: memory access out of bounds
- ghostty-web/bytes/8, repetitions 1, 2, 3: page.evaluate: RuntimeError: memory access out of bounds
- ghostty-web/bytes/17, repetitions 1, 2, 3: page.evaluate: RuntimeError: memory access out of bounds
- ghostty-web/string/1, repetitions 1, 2, 3: page.evaluate: RuntimeError: memory access out of bounds
- ghostty-web/string/8, repetitions 1, 2, 3: page.evaluate: RuntimeError: memory access out of bounds
- ghostty-web/string/17, repetitions 1, 2, 3: page.evaluate: RuntimeError: memory access out of bounds
- xterm-dom/bytes/17, repetitions 2: Error: Presented green glyph timed out; latest capture: {"timestamp":1790843415318.51,"colors":{"red":0,"green":0,"redPeak":0,"greenPeak":0,"width":1600,"height":1400}}
- xterm-dom/bytes/8, repetitions 3: Error: Presented green glyph timed out; latest capture: {"timestamp":1790843609028.6218,"colors":{"red":0,"green":0,"redPeak":0,"greenPeak":0,"width":1600,"height":1400}}
- xterm-dom/string/8, repetitions 3: Error: Presented green glyph timed out; latest capture: {"timestamp":1790843641477.5432,"colors":{"red":0,"green":0,"redPeak":0,"greenPeak":0,"width":1600,"height":1400}}
- xterm-dom/string/17, repetitions 3: Error: Presented green glyph timed out; latest capture: {"timestamp":1790843654910.455,"colors":{"red":0,"green":0,"redPeak":0,"greenPeak":0,"width":1600,"height":1400}}

## Screenshot review

Reviewed the first terminal in all 24 first-repetition screenshots across both input paths and all three counts, all four complete 17-terminal byte-path grids, all five xterm DOM direct/capture failure pairs, a ghostty-web Unicode-trap screenshot, and atlas-inclusive headed smoke screenshots. The measured build includes main 913cb14f3 (#237).

- ASCII, SGR text, Japanese text, combining accents, and cursor overwrite are visible across all baseline screenshots. Each complete 17-terminal grid has all 17 hosts populated.
- The native woman-technologist sequence now shows the laptop with its intrinsic grayscale detail; the first run's white rectangular laptop block is gone. The woman and laptop still appear as separate constituents, so this fixes atlas color preservation and does not establish composed ZWJ shaping.
- Native and ghostty-web timing-run screenshots show separate family constituents; xterm WebGL shows overlapping constituents, while xterm DOM composes the sequences. The legacy string smoke composes them, unlike the repeated-chunk timing baseline. Unicode/ZWJ shaping parity is not claimed.
- Default ANSI palette shades and ghostty-web row spacing differ. Font family, font size, DPR, corpora, and terminal grid are held constant.

### Qualification notes

- The corrected matrix attempted 72 cases in 10 minutes 59.706 seconds (08:25:03.430–08:36:03.136 UTC): 49 completed rendered cases and 23 retained failures. Native WebGPU and xterm WebGL completed all 18 cases each. AC was checked immediately before starting and before every case; the artifact records AC Power and a headed Apple M1 Metal renderer.
- All 120 timed isolated-parser samples (four variants × two paths × five corpora × three repetitions) passed same-instance final viewport, cursor, and SGR qualification. They use the corrected synchronous parser boundary, and remain eligible independently of rendered failures. The first run's parser numbers had a different timing boundary and cannot establish a code-only performance delta.
- The former ghostty-web/string/1 parser failure was the harness's empty decoder flush during ASCII warmup, not Unicode. Empty streaming chunks and an empty final flush are now omitted. Direct core and documented mounted Terminal.write('') still throw RangeError: offset is out of bounds in the pinned 0.4.0 library; the benchmark no longer sends that unnecessary call.
- ghostty-web 0.4.0 now qualifies all byte/string parser corpora, but every rendered case traps in synchronous nonempty Unicode burst writes at 1, 8, and 17 terminals (18 failures). The untimed original-corpus diagnostic reproduces RuntimeError: memory access out of bounds on the 22nd mounted public write and 23rd direct core write, using 4,118 nonempty bytes per call, on both input paths. The trace stops before write completion. No presentation callback is passed; the trap is independent of the removed empty flush and extra-frame adapter wait. Its rendered/resource cells remain unmeasured.
- The one-byte UTF-8 correctness smoke records xterm 6.0.0 losing ZWJ codepoints on the byte path for both renderers. The same original corpus qualifies with timed 4 KiB chunks and on the decoded-string smoke path. Smoke exits nonzero for these diagnostics; its baseline renderer, echo, and history checks pass. No smoke timing replaces measured values.
- Five xterm DOM cases timed out awaiting a captured green glyph: bytes/8 repetitions 1 and 3, bytes/17 repetition 2, string/8 repetition 3, and string/17 repetition 3. All five direct failure screenshots show the green glyph; all five final screencast images leave its first-terminal area blank. These are capture qualification failures, not evidence of a renderer failure. The cause of missing compositor capture remains unconfirmed. Incomplete three-repetition rendered/resource cells are unmeasured.
- Successful latency phases retain classification, timestamp, metadata, and encoded length for every screencast frame, including unaccepted frames. Failed latency phases retain the final capture image/metadata and direct screenshot, but their partial stream is not serialized. Equal capture cadence or optical-display latency is not established.
- Per-10k memory deltas include first ASCII-output and renderer-cache growth. Retained JS/backing storage, WASM capacity, and whole-Chromium RSS are separate buckets; none is per-terminal total memory. CPU samples reject process-set churn. PNG paths are retained per case; Git deduplicates identical blobs.

### Evidence

- [Native WebGPU, 17 terminals; laptop atlas detail](benchmarks/mac-m1/ghostty-webgpu-bytes-17.png)
- [xterm WebGL, 17 terminals](benchmarks/mac-m1/xterm-webgl-bytes-17.png)
- [xterm DOM, 17 terminals](benchmarks/mac-m1/xterm-dom-bytes-17.png)
- [ghostty-web, 17 terminals](benchmarks/mac-m1/ghostty-web-bytes-17.png)
- [Direct screenshot with echoed green glyph](benchmarks/mac-m1/failure-xterm-dom-bytes-8-0.png)
- [Final compositor capture missing that glyph](benchmarks/mac-m1/capture-failure-xterm-dom-bytes-8-0.png)
- [ghostty-web nonempty Unicode burst trap screenshot](benchmarks/mac-m1/failure-ghostty-web-bytes-17-0.png)
- [Atlas-inclusive headed correctness and exact API diagnostics](benchmarks/mac-m1/smoke-headed/comparison.json)
- [Native atlas-inclusive headed smoke screenshot](benchmarks/mac-m1/smoke-headed/ghostty-webgpu-string-1.png)
