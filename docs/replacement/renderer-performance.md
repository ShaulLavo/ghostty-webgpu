# Renderer performance, 2026-09-05

This pass reduces Canvas2D drawing work and cursor-update CPU on all three renderers.
It compares the working tree with `f2a56e989889fd549836cd9aae5d131cc7f5f2a9`.
The [recorded samples](renderer-performance-2026-09-05.json) include bundle hashes and per-run values.

## Measurements

Headed Chromium 148.0.7778.96 ran on Linux Wayland with an NVIDIA RTX 3060 Ti,
driver 610.57.04. Each terminal had 200 columns, 50 rows, DPR 2, and the same measured
13px monospace font. Each scenario ran three times, alternating source and backend order,
with 200 seed lines, 10 warmup steps, and 60 measured steps. Idle samples lasted two seconds.

CPU seconds sum cumulative CPU deltas across Chromium processes. Work advances once per animation
frame, so these samples measure CPU cost for paced workloads, not maximum throughput.
Each non-idle sample processes fixed work, so elapsed time can increase when frames are missed. Callback p95 measures JavaScript
execution, including submission calls. It does not measure GPU completion or input-to-display latency.
The table reports the median CPU seconds and median per-run callback p95 across three repetitions.

| Renderer | Scenario        | CPU seconds, before → after | Callback p95 ms, before → after |
| -------- | --------------- | --------------------------- | ------------------------------- |
| Canvas2D | Cursor movement | 0.36 → 0.10                 | 5.1 → 0.5                       |
| Canvas2D | Burst output    | 1.38 → 1.21                 | 11.0 → 8.2                      |
| Canvas2D | Scrolling       | 1.39 → 1.26                 | 10.8 → 10.1                     |
| Canvas2D | Glyph churn     | 1.00 → 0.93                 | 10.2 → 8.1                      |
| WebGL2   | Cursor movement | 0.36 → 0.12                 | 5.6 → 0.6                       |
| WebGL2   | Burst output    | 0.65 → 0.66                 | 8.9 → 9.0                       |
| WebGL2   | Scrolling       | 0.69 → 0.65                 | 13.2 → 9.2                      |
| WebGL2   | Glyph churn     | 0.91 → 0.92                 | 13.7 → 13.7                     |
| WebGPU   | Cursor movement | 0.37 → 0.12                 | 5.4 → 0.6                       |
| WebGPU   | Burst output    | 0.66 → 0.65                 | 10.2 → 10.2                     |
| WebGPU   | Scrolling       | 0.67 → 0.66                 | 10.4 → 9.4                      |
| WebGPU   | Glyph churn     | 0.91 → 0.90                 | 14.0 → 13.6                     |

All native idle samples requested zero frames, before and after. Tiny idle CPU differences are
below useful resolution. The 60 cursor moves decoded 120 rows after this pass, down from 3,120.
Every paired native run produced matching text hashes and byte counts, with no pending frames
or browser process churn at completion. Screenshots verified visible glyphs without another draw.

Tolerances came from an exploratory run's baseline repeatability before judging the final run.
CPU tolerance was the greater of 0.05 seconds and twice the median absolute deviation.
Callback p95 tolerance was the greater of 0.5ms and twice that deviation.
All final median comparisons pass these engineering thresholds. Three repetitions do not establish
statistical confidence. Individual tails still vary: one candidate WebGPU burst run reached 16.9ms,
while the other two reached 10.2ms and 8.9ms. GPU output CPU cost is effectively unchanged here.

An exploratory comparison with ghostty-web 0.4.0 recorded 121 requested frames in each two-second
idle sample, versus zero for our Canvas2D renderer. Cross-package throughput remains unqualified:
the packages produced different cell sizes, and the baseline's glyph-churn buffer text differed.
The original comparison's `font` field incorrectly reported native metrics for ghostty-web.
The runner now reports its requested font separately from native measured metrics.

## Changes and correctness

Canvas2D batches adjacent cell backgrounds, reuses paint state and font strings, and caches color
conversion and contrast decisions with bounded storage. A 160-cell test reduces background fills
from 160 to 2, font and alignment assignments from 160 each to 1 each, and fill-style assignments
from 320 to 4. Forty-five scenes matched the original Canvas2D renderer byte for byte across
Unicode, decorations, cursor shapes, transparency, contrast settings, and DPR 1, 1.5, and 2.

All renderers request only missing cursor or refresh rows from the native state. They avoid frame
snapshot copies when no observer consumes them. The benchmark keeps an observer enabled.
WebGPU reuses one glyph lookup per frame. WebGL2 skips atlas setup when no uploads are pending.

The GPU rasterizer bitmap cache now retains at most 4MiB of pixel and UTF-16 key data and
4,096 entries per rasterizer. Object overhead is outside the byte budget but bounded by the entry
limit. Cache hits update recency only under pressure. Updating the Map on every hit caused a
measured regression during development. Eviction and high-DPR tests cover both limits.
Speculative shader changes were removed because the measurements did not justify them.

This pass does not measure cold startup, total native or GPU memory, physical input latency,
multiple terminals, or other devices. Plan 016 remains open.

Local validation passes typecheck, lint, formatting, 355 unit tests, the build, and an external
packed-consumer check. Headed Canvas2D and atlas tests pass all 21 cases. The full software-rendered
browser suite passed 181 cases and failed one existing dotted-versus-dashed decoration assertion.
That assertion also fails on the original shaders. Hardware GPU tests additionally reproduce
existing alpha rounding and screenshot dimension failures. These assertions remain enabled.
Built-package hardware checks display and recolor text, select text, and dispose all three backends.

## Reproduce

Run with an available desktop and hardware adapter. The runner selects Wayland on Linux when
`WAYLAND_DISPLAY` is set. Keep other browser workloads stopped during measurement.

```sh
git worktree add --detach /tmp/ghostty-perf-before f2a56e989889fd549836cd9aae5d131cc7f5f2a9
ln -s "$PWD/node_modules" /tmp/ghostty-perf-before/node_modules
BENCH_BASELINE_ROOT=/tmp/ghostty-perf-before BENCH_STEPS=60 BENCH_WARMUP_STEPS=10 \
  BENCH_REPETITIONS=3 BENCH_SAMPLE_SECONDS=2 \
  BENCH_OUTPUT=.artifacts/performance-pass/repeated.json bun run bench:renderer
```

`BENCH_BACKENDS` selects `canvas2d,webgl2,webgpu,ghostty-web`; the default excludes ghostty-web.
`BENCH_SCENARIOS` selects the five scenario names recorded in the JSON. `BENCH_HEADLESS=1`
allows correctness probes but never qualifies hardware performance. `performanceQualified`
describes measurement conditions only; compare geometry and output before comparing backends.

The runner saves raw CPU and timing samples, process data, JavaScript heap observations, output
hashes, screenshots, browser metadata, and exact bundles beside `BENCH_OUTPUT`. Original full
results remain local under `.artifacts/performance-pass/hardware-accepted.json`. Earlier runs
shared screenshot names; new runs prefix them with the output filename to preserve each run.

The built package can also exercise the same desktop path:

```sh
bun run build
GHOSTTY_BROWSER_HARDWARE=1 bun run test:renderer-smoke
GHOSTTY_BROWSER_HARDWARE=1 bun run test:browser src/render/canvas/ src/render/atlas/
```
