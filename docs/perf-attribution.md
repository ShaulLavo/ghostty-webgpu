# Output and input latency attribution

Status: Phase 1 measured and review repairs completed on 2026-10-01. A corrected 17-terminal ASCII CPU rerun supplements the original attribution matrix. Phase 2 implements packed damaged-row snapshots and measures main versus treatment on the Apple M1 at 1 and 17 terminals, ASCII and SGR. The initial matrix has mixed CPU results. A single direct-packed DOM frame follow-up improves CPU in all fresh 17-terminal ASCII/SGR pairs; substantial baseline drift between matrices remains unexplained. The PR stays draft for review. Phase 1's input/echo conclusions remain separate.

## Shared browser clock and bounded GPU sharing, Linux 2026-10-03

**Decision: no established CPU benefit; leave the scheduler unmerged.** The shared-clock candidate
has adverse WebGL CPU observations at 17 terminals and essentially unchanged WebGPU CPU. Latency
is mixed, and the single-terminal no-regression guard is unestablished. The remaining two WebGPU
single-terminal windows and all four rolling-output callback traces were stopped before execution
by coordinator direction. This section and its evidence are documentation only; scheduler code
remains on [`plan-283-shared-scheduler`](https://github.com/ShaulLavo/fregat/tree/plan-283-shared-scheduler)
at `3ea4a9d64b2e17d08928c4242649bc73cc3156d8`, unmerged and undeployed. No version changes are included.

### Candidate, matched work, and qualification

The candidate caches one browser clock per Window and delivers pending terminal callbacks in one
synchronous animation-frame batch. Each terminal retains its own RenderScheduler, blink timers,
focus/visibility/disposal state and stale-callback guards. Cancellation can remove a peer during
delivery; synchronous flush stays synchronous, and the owning Window reports callback exceptions
synchronously so error recovery can cancel a peer. New work during delivery waits for another
frame. The batch intentionally changes ordering: microtasks and unrelated native rAF callbacks
cannot interleave between terminal callbacks. This is an atomic-batch tradeoff, not native
per-callback ordering equivalence. GPU device ownership and submission remain unchanged.

Baseline `45f22aa0b69a5eb111d64763cf537913e13b6843` and treatment `3ea4a9d64…` use separately frozen
runtime archives with identical benchmark sources, versions, fonts, WASM and fixtures. The exact
runtime inventory delta is `config.ts`, `shared-clock.ts` and their two scheduler test files.
The shared benchmark source SHA-256 is `319bf475fbccd67e759b1651a54f75f41e831fd1c426afe39cb59ec0a105d908`.
An earlier baseline containing an atlas confound was excluded before measurement. Full identities
and source inventories are retained in [the clock evidence](benchmarks/linux-shared-clock-2026-10-03/).

Six ordinary windows complete: before/after WebGL at 17 and one terminal, and before/after WebGPU
at 17. Each window has four balanced native/xterm-WebGL repetitions, rolling Git-history bytes,
output plus latency, and 96 input and 96 write samples per repetition. Seventeen terminals use
1,200 output frames; one uses 2,700. WebGPU explicitly selects `--frame-builders zig`. Every native
terminal submits exactly the expected output frames through Zig, with zero measured-window JS
fallback. All 48 cases complete with empty page-error arrays, stable CPU process sets and qualified
recorded GPU idle/measured windows. No rejected or operator-stopped partial case enters these tables.

Chromium headless-shell 153.0.8010.12 uses NVIDIA Vulkan on the RTX 3060 Ti, NVIDIA 610.57.4;
WebGPU records a non-fallback NVIDIA Ampere adapter. These are hardware-adapter headless workload
measurements, not physical-display frame timing. The rolling corpus and stream hashes are the
same as the preceding headline WebGL matrix: `5b962d02…` and `044a9381…`. The original GPU limits
remain utilization ≤5% for idle admission and foreign compute residency ≤1,024 MiB; qualification
bounds those observations, not graphics uncontendedness or CPU/thermal stability.

### Ordinary output CPU

Values are medians across four repetitions, percent of one core. GPU process means CPU consumed
by that process, not GPU hardware execution time. Totals are calculated per case before taking
medians; component medians need not sum to the total. Before/after conditions occupy separate
browser sessions. Only native/xterm ratios within each condition are paired; cross-condition
changes below are descriptive observations, not same-session paired treatment speedups.

| Backend / terminals | Output CPU  | Native before → after | xterm WebGL before → after |
| ------------------- | ----------- | --------------------: | -------------------------: |
| WebGL / 17          | Renderer    |       21.146 → 28.695 |            25.022 → 25.894 |
| WebGL / 17          | GPU process |       29.451 → 38.184 |            30.722 → 33.214 |
| WebGL / 17          | Total       |       51.116 → 68.703 |            56.888 → 60.203 |
| WebGPU / 17         | Renderer    |       25.518 → 25.261 |            23.299 → 23.976 |
| WebGPU / 17         | GPU process |       64.870 → 65.026 |            29.224 → 29.075 |
| WebGPU / 17         | Total       |       90.778 → 90.987 |            54.201 → 53.844 |
| WebGL / 1           | Renderer    |         4.182 → 4.515 |              4.216 → 5.164 |
| WebGL / 1           | GPU process |         2.407 → 2.574 |              2.418 → 2.937 |
| WebGL / 1           | Total       |         7.310 → 7.910 |              7.423 → 9.054 |

All four native WebGL-17 renderer samples rise: 21.523/20.672/20.769/24.007 →
35.411/23.383/23.019/34.007% core. Treatment repetition 0 includes a 349.985 ms paced interval
and 9.265 ms CPU-acquisition uncertainty; its xterm repetition 1 has a 133.328 ms interval and
eight intervals over 25 ms. These outliers remain in the evidence. The smooth native repetition 2
also rises, so discarding outliers cannot erase the adverse observation. Independent source and
first-pair evidence review found no correctness defect or unmatched output work explaining it.
GPU qualification does not resolve CPU/thermal/GC drift, and no output trace was taken to attribute
the increase to Map allocation, dispatch, rendering or ANGLE. WebGPU-17 total and GPU-process CPU
stay essentially flat. Neither backend establishes the intended CPU improvement.

### Latency and paired targets

Latency is milliseconds to compositor presentation acknowledgement of the submitting frame,
not physical-vsync or optical latency. Values are medians of run quantiles: p50 uses the mean
of the two middle samples, p95 uses nearest rank.

| Backend / terminals | Latency   | Native before → after | xterm WebGL before → after |
| ------------------- | --------- | --------------------: | -------------------------: |
| WebGL / 17          | Input p50 |       21.144 → 20.478 |            20.688 → 20.916 |
| WebGL / 17          | Input p95 |       24.831 → 24.006 |            27.682 → 27.320 |
| WebGL / 17          | Write p50 |       15.432 → 15.354 |            14.568 → 13.262 |
| WebGL / 17          | Write p95 |       19.333 → 20.501 |            19.366 → 18.811 |
| WebGPU / 17         | Input p50 |       20.107 → 20.055 |            20.597 → 20.699 |
| WebGPU / 17         | Input p95 |       28.760 → 26.602 |            31.175 → 26.995 |
| WebGPU / 17         | Write p50 |       15.587 → 16.674 |            15.008 → 16.602 |
| WebGPU / 17         | Write p95 |       20.434 → 20.688 |            19.648 → 19.600 |
| WebGL / 1           | Input p50 |         5.009 → 5.176 |              4.875 → 5.008 |
| WebGL / 1           | Input p95 |       21.083 → 26.576 |            20.637 → 24.444 |
| WebGL / 1           | Write p50 |        9.797 → 15.066 |             7.945 → 13.505 |
| WebGL / 1           | Write p95 |       20.311 → 20.624 |            19.999 → 20.081 |

Paired values below are medians of individual native/xterm ratios, target ≤1, not ratios of the
absolute medians above. CPU retains the runner's 100-tick/one-tick resolution rules: both
single-terminal renderer comparisons are unresolved. Idle CPU was not measured; GPU-process CPU
and write p95 have no formal paired target in this runner.

| Backend / terminals | Target       |              Before |               After |
| ------------------- | ------------ | ------------------: | ------------------: |
| WebGL / 17          | Renderer CPU |       0.891362 pass |       1.102044 fail |
| WebGL / 17          | Total CPU    |       0.958804 pass |       1.176398 fail |
| WebGL / 17          | Input p50    |       1.010291 fail |       0.974098 pass |
| WebGL / 17          | Input p95    |       0.869884 pass |       0.864815 pass |
| WebGL / 17          | Write p50    |       1.045326 fail |       1.217566 fail |
| WebGPU / 17         | Renderer CPU |       1.088882 fail |       1.067466 fail |
| WebGPU / 17         | Total CPU    |       1.695180 fail |       1.694628 fail |
| WebGPU / 17         | Input p50    |       0.972755 pass |       0.970473 pass |
| WebGPU / 17         | Input p95    |       0.911965 pass |       1.030543 fail |
| WebGPU / 17         | Write p50    |       1.038431 fail |       0.991949 pass |
| WebGL / 1           | Renderer CPU | 1.002406 unresolved | 0.873190 unresolved |
| WebGL / 1           | Total CPU    |       1.003142 fail |       0.875608 pass |
| WebGL / 1           | Input p50    |       1.038989 fail |       1.101060 fail |
| WebGL / 1           | Input p95    |       1.020320 fail |       1.118534 fail |
| WebGL / 1           | Write p50    |       1.234769 fail |       1.186313 fail |

WebGL-17 absolute write p50 is essentially unchanged, while its normalized ratio worsens because
the control changes. WebGPU-17 absolute input p95 improves, while the control improves more and
the paired-ratio median worsens. Single-terminal native WebGL latency rises, with substantial
control shifts too. Arrival phase and cross-session variation limit causal attribution; these
observations establish neither a scheduler-caused latency regression nor the required no-regression
guard. WebGPU single-terminal latency was not measured. No favorable-only rerun replaces a
qualified window.

### Bounded shared-device/submission probe

Production integration stopped at the complexity boundary. A standalone synthetic ABC probe keeps
17 separate canvases and 17 encoders per page frame while changing device/submit ownership:
A uses 17 devices and 17 submits, B one device and 17 submits, C one device and one submit. Each
canvas has a 560×456 backing surface at DPR 2 and a 40×12 instanced grid with two draws. All three
modes use the same single page-rAF callback. Fixed instances and animated uniform writes omit the
terminal parser, builder and streaming glyph atlas.

Four ordinary repetitions use 1,200 frames per mode; four separate trace repetitions use 240.
Orders ABC/CBA/BCA/ACB balance pair precedence, but A never occupies the middle position. Recorded
encoder, draw, submit, device and canvas counts are checked. Pre-measurement checks draw each canvas
at frame zero and compare red-channel checksums plus bright/dark pixel sanity. Warmup and measurement
follow; measured-output correctness and full-RGBA equality are unverified. The positive C screenshot was read back. All ordinary CPU windows have stable process sets, 1,145–1,311 GPU CPU
ticks, midpoint CDP denominators and acquisition uncertainty ≤0.679 ms. Recorded NVIDIA gates
qualify while permitting stable 269 MiB foreign compute residency; graphics uncontendedness is
unestablished. Every trace has 240 observed page-frame markers; trace-r2/B contains one 33.3 ms gap.

| Synthetic mode | Devices / submits per page frame | GPU-process CPU, % core | Renderer CPU, % core | Inclusive Flush, ms / observed page frame |
| -------------- | -------------------------------: | ----------------------: | -------------------: | ----------------------------------------: |
| A              |                          17 / 17 |                  65.181 |                8.406 |                                     9.250 |
| B              |                           1 / 17 |                  63.453 |                7.606 |                                     8.743 |
| C              |                            1 / 1 |                  57.431 |                5.653 |                                     7.707 |

| Paired synthetic reduction | GPU-process CPU | Inclusive Flush duration |
| -------------------------- | --------------: | -----------------------: |
| A → B                      |          2.152% |                   5.560% |
| B → C                      |          9.490% |                  10.232% |
| A → C                      |         11.759% |                  16.914% |

These are medians of per-repetition reductions, distinct from ratios of mode medians. Flush is
an inclusive host trace-span sum, may overlap, and is neither self CPU nor hardware GPU time.
Traced CPU does not enter ordinary CPU comparisons. B→C also groups `writeBuffer` operations
before submission, so it does not isolate a fixed per-submit cost. Headless page frames are not
physical display frames. This toy result establishes neither production benefit nor dominance of
submission cost. Shared-device generation leases, loss recovery and disposal, plus deferred-submit
resource lifetime, damage acknowledgement and callback settlement, would expand production
ownership contracts. Those changes were deliberately not integrated.

### Evidence, verification, and stop boundary

[Retained compact evidence](benchmarks/linux-shared-clock-2026-10-03/) includes the six-condition
results, every repetition's CPU snapshots/brackets/ticks, latency quantiles, pacing and terminal
counters, exact paired verdicts, frozen manifests and the qualified synthetic probe aggregate.
The raw ordinary comparisons, latency traces, screenshots, rejected attempts, admission logs,
frozen bundles and one-off analysis input are preserved under
`/work/reports/ghostty-benchmarks/plan-283/shared-scheduler/`. Raw synthetic inputs, 12 traces,
recorded sources/provenance and the original unmodified aggregate remain under
`/work/reports/ghostty-benchmarks/plan-283/shared-submission-probe/`; `aggregate-qualified.json`
corrects the earlier overly broad pixel-equality wording without relabeling captured originals.

Focused source verification passed 22 scheduler/configuration/cursor units; the later frozen-source
check passed 21 scheduler/configuration units and 129 browser tests. Three existing skips cover
two Linux replacement-device cases and a DOM font-layout case lacking Liberation Mono and
WenQuanYi Zen Hei. Package build/typecheck passed in both runs; commands and complete zero-exit
logs are retained in the ordinary report's `source-verification/`. Real Chromium confirms atomic batch ordering
and native/shared synchronous error recovery. The six native correctness-fixture screenshots were
read back: all expected canvases show ASCII, colors, wide/accented text, emoji and overwrite output.
These are fixture screenshots, not final rolling-history captures.

Callback source locations were calibrated against existing real latency traces and the frozen
bundles; this proves observability, not multi-terminal output callback reduction. A focused test
proves 17 pending terminals share one native frame, but the planned four rolling-output traces
were canceled, so no measured output callback-reduction or output-CPU attribution claim is made.
The two GPU-one-terminal windows also remain unmeasured. Failed GPU admission, the pre-fix
fractional-timeout attempt, and operator-stopped quiet/server-deadlock setup remain rejected.
Foreign GPU/browser processes were not stopped and admission thresholds were not loosened.

Historical reproduction uses the measured treatment checkout for the identical benchmark driver:

```sh
bun scripts/build-comparison.ts <before-bundle> --runtime-ref 45f22aa0b69a5eb111d64763cf537913e13b6843
bun scripts/build-comparison.ts <after-bundle> --runtime-ref 3ea4a9d64b2e17d08928c4242649bc73cc3156d8
node <bundle>/comparison-runner.mjs --variants ghostty-webgl --phases output,latency \
  --counts 17 --paths bytes --repetitions 4 --output-frames 1200 --latency-samples 96 \
  --output-fixture rolling-logs --fixtures rolling-logs --output <run-directory>
```

For the measured WebGPU pair use `--variants ghostty-webgpu --frame-builders zig`; the measured
single-terminal WebGL pair uses `--counts 1 --output-frames 2700`. Hardware jobs use quiet heavy
admission, yielding to owner-priority windows and waiting outside the queue for long-lived dev
servers and the original GPU limits. These commands document the six completed windows; they
request no additional run. The stopped candidate provides a negative result worth retaining,
not an approved scheduler optimization or a production shared-device/submission implementation.

## Zig-fed native WebGL, Linux 2026-10-02–03

WebGL now defaults to the existing Zig frame builder for supported content. Its persistent WASM
buffers already match the 64-byte cell and 96-byte glyph layouts, so the text pass uploads nonempty
changed ranges directly, with byte destination offsets and float-element source offsets. There is
no record repacking, shader change, new tuning option or trailing-blank heuristic. WebGPU keeps its
existing opt-in default; the Terminal host preserves an omitted option so each renderer chooses its
own default.

Unsupported frames use the existing whole-frame JavaScript producer. Producer changes, geometry,
atlas/font resets and context restoration force full rebuilds. Shared grayscale-glyph registration
pins native-index residency to synthetic row `-1`, independently of viewport row zero, and releases
that residency when JavaScript takes over. Builder replacement/disposal keeps the existing WASM
ownership and allocation-failure guards. Damage and internal invalidation settle before callbacks;
unchanged successful builds settle callbacks without uploads or submission. `zigFrames` counts
submitted native frames, matching the WebGPU metric.

Correctness checks pass: 70 browser tests with two existing Linux SwiftShader replacement-device
skips, 24 core Zig differential/ownership tests and five tracing regressions. Shared ASCII, SGR
and cursor fixtures compare independent native/JavaScript sources; missing-glyph retry, fallback
and return, offsets/empty ranges, reentrant invalidation, no-op settlement, shrink, allocation
recovery, disposal, atlas eviction/reset and actual context restoration are covered. Scheduled GL
draws and compositor screenshots are checked before the capture helper redraws. The oversized atlas
stress canvases have explicit fully-visible viewport bounds. Package build/typecheck and root gates
pass. This is focused verification; the full package suite and other browser engines were not run.

### Initial treatment timing, before differential scroll refresh

The initial treatment below still forced full native uploads on scroll. Its frozen evidence is retained
as `after-17.json` and `after-1.json`; final-source measurements are separate. Scroll now refreshes
every viewport row without forcing unchanged instance records. This does not assume shifted rows
are identical: byte attribution also exercises distinct full-width and ragged lines.

Before and treatment use separate frozen bundles; every native/xterm pair shares one browser
session. ASCII/bytes, four balanced repetitions, output plus latency, 96 samples per operation:
17 terminals use 1,200 output frames, one uses 2,700. Chromium headless-shell 153.0.8010.12 runs
ANGLE/NVIDIA Vulkan on the RTX 3060 Ti with NVIDIA 610.57.4. All ordinary runs complete, all measured
GPU windows and between-repetition GPU gates qualify, and every page-error array is empty. Each
quiet benchmark starts only after an empty heavy-job list and idle GPU; long-running jobs are waited
for outside the queue.

CPU values are medians, percent of one core. GPU process means **CPU consumed by the GPU process**,
not device GPU utilization.

| Terminals | Output CPU       | Native before → after | xterm WebGL before → after |
| --------: | ---------------- | --------------------: | -------------------------: |
|        17 | Renderer process |       28.783 → 15.998 |            15.388 → 15.714 |
|        17 | GPU process      |       25.381 → 25.418 |            24.806 → 24.903 |
|        17 | Total            |       54.199 → 41.416 |            40.315 → 40.642 |
|         1 | Renderer process |         3.950 → 3.151 |              2.807 → 2.841 |
|         1 | GPU process      |         2.252 → 2.396 |              2.397 → 2.385 |
|         1 | Total            |         6.202 → 5.603 |              5.204 → 5.204 |

Native renderer CPU falls 44.4% at 17 terminals and 20.2% at one; total CPU falls 23.6% and 9.7%.
The nearly flat xterm control supports a producer-related improvement. GPU-process CPU stays flat
at 17 terminals. **The decision gate of total CPU clearly below xterm is not met.** This result does
not approve expanding native support or deleting the unsupported-content JavaScript fallback.

Latency is milliseconds to the submitting frame's on-demand compositor presentation acknowledgement,
not physical-vsync or optical latency. These are medians of each run's quantiles.

| Terminals | Latency   | Native before → after | xterm WebGL before → after |
| --------: | --------- | --------------------: | -------------------------: |
|        17 | Input p50 |         5.735 → 5.926 |            20.777 → 20.736 |
|        17 | Input p95 |       24.002 → 22.119 |            28.419 → 29.833 |
|        17 | Write p50 |       16.102 → 16.736 |            14.429 → 15.113 |
|        17 | Write p95 |       20.534 → 20.850 |            18.840 → 19.111 |
|         1 | Input p50 |         5.218 → 5.342 |              4.770 → 4.822 |
|         1 | Input p95 |       22.837 → 22.574 |            22.760 → 21.337 |
|         1 | Write p50 |        9.673 → 12.351 |            12.966 → 12.431 |
|         1 | Write p95 |       20.341 → 20.334 |            20.115 → 20.079 |

This establishes CPU improvement, not latency improvement. Native write p50 rises at both counts;
one-terminal input p50 rises too. No new latency-only run or physical-presentation claim is made.

Paired ratios are medians of individual native/xterm ratios with target ≤ 1, not ratios of the
absolute medians above. CPU resolution is 10 ms; fewer than 100 ticks or sides within one tick make
a pair unresolved. Two 17-terminal renderer pairs have equal ticks; one one-terminal total pair has
246 versus 247 ticks. Those targets remain unresolved even when their numerical median is finite.
Idle CPU was not measured; GPU-process CPU and write p95 have no formal paired target in this runner.

| Target       |  17 before |         17 after |   1 before |          1 after |
| ------------ | ---------: | ---------------: | ---------: | ---------------: |
| Renderer CPU | 1.859 fail | 1.010 unresolved | 1.413 fail |       1.122 fail |
| Total CPU    | 1.343 fail |       1.011 fail | 1.189 fail | 1.064 unresolved |
| Input p50    | 0.274 pass |       0.287 pass | 1.072 fail |       1.092 fail |
| Input p95    | 0.836 pass |       0.794 pass | 0.950 pass |       1.031 fail |
| Write p50    | 1.125 fail |       1.105 fail | 0.718 pass |       1.017 fail |

Compact records, exact paired statuses/ticks, all latency arrays, qualification, frozen manifests
and before/after screenshots are in [the WebGL evidence](benchmarks/linux-zig-webgl-2026-10-02/).
`results.json` reproduces these absolute tables. `provenance.json` verifies unchanged settings,
fixtures, versions and WASM/script/font assets. The runner's `frameBuilders` field selects WebGPU
only; WebGL uses its renderer default, so that field does not identify this treatment's producer.
Before/after qualification PNGs are byte-identical for native and xterm at both counts; native
treatment screenshots were read back. They include unsupported content and exercise fallback;
the separate browser tests prove supported native-frame pixel parity.

### Differential scroll refresh and fixture bias

The pre-fix regressions reproduce full uploads despite byte-identical rows: a real 12×3 Terminal
sends 5,760 bytes in six writes, and a 32×3 viewport scroll sends all 15,360 bytes. Refreshing every
viewport row through the existing overlay mask keeps native record comparisons active. The same
real-host case then sends zero bytes; scrolling distinct rows up and down keeps sub-full uploads
and scheduled native/JavaScript compositor parity.

The exact ASCII fixture repeats the same ending viewport after its first measured frame. Stock
Git-history `logs` also writes the entire same corpus per frame, because its unit already exceeds
4 KiB. These workloads flatter native differential upload and no-op submission: xterm continues
uploading/rendering rows. They are secondary evidence, not the realistic-output go/no-go gate.

The byte oracle separately checks distinct full-width history rows: all 480 glyph records change,
all 480 cell/background records remain identical, and there are no trailing blanks. Uploads are
46,080 glyph bytes in 12 writes versus 76,800 bytes in 24 writes before the scroll fix: 40% byte
saving solely from unchanged cell/background records, with no repeated text benefit. Ragged lines
measure trailing-blank and unchanged-record effects separately; missing-glyph retry still forces
full uploads for correctness. Every measured scheduled backbuffer matches the independent full
JavaScript oracle, followed by final displayed-pixel comparison. This byte probe carries no CPU
or presentation-latency claim.

The reproducible `rolling-logs` fixture advances through the real Git-history corpus in nominal
4,096-byte chunks, ending at complete UTF-8 codepoints and wrapping deterministically. Byte and
string paths carry the same stream; each burst resets its offset, keeping warmup separate from the
measured sequence. Real-core tests require all 2,700 successive viewports to change and retain
stock repeated logs as a positive control. The original en dash stays in the corpus; unsupported
visible content can still select the whole-frame JavaScript fallback.

The separate eight-frame rolling byte oracle sends 423,360 instance bytes in 132 writes versus
614,400 bytes in 192 writes before the scroll fix: **31.09% fewer bytes**, including three full
missing-glyph retry uploads. Every whole/glyph/text row changes at every step; twelve background
rows remain identical. All 56 measured operations across seven workloads match the full JavaScript
oracle, and all seven final displayed screenshots agree. Sampled rolling viewports contain no
fallback, because the en dash is outside those viewports; this does not establish native support
for that content or describe the full timing workload. `scroll-byte-attribution.json` retains its
exact runtime, protocol, benchmark-helper and bundle hashes. Later driver metadata edits have their
own hashes and are not retroactively assigned to this byte proof.

The headline before/final CPU matrices will use this advancing fixture, with stream and runtime
source provenance kept separate from the benchmark driver. Reproduce from `ghostty-webgpu/`:

```sh
bun scripts/build-comparison.ts <before-bundle> --runtime-ref 2c185da7831b3673ca0520ee648663f69d2483fe
bun scripts/build-comparison.ts <final-bundle>
node <bundle>/comparison-runner.mjs --variants ghostty-webgl --phases output \
  --output-fixture rolling-logs --fixtures rolling-logs --paths bytes \
  --counts 17 --repetitions 4 --output-frames 1200 --output <run-directory>
```

Repeat with `--counts 1 --output-frames 2700`. Each hardware command runs in a `--quiet` heavy
benchmark window; finite jobs ahead can finish while the queued quiet job holds back later work.
Long-running servers are waited for outside admission. Use the portable runner directly:
`bench:compare` rebuilds checkout runtime and does not select the archived baseline. The builder
archives runtime sources from the repository root and uses the same current driver, fixtures,
fonts, WASM and settings for both bundles. Shared whitespace/comment minification removes random
archive paths while preserving function identifiers. A second baseline build must produce
byte-identical `browser.js` before measurements begin.

The first archived-baseline attempt failed recorder setup in all four native cases because the
JS-only runtime has neither `drawZigFrame` nor `uploadFrame`; all four xterm controls completed.
`rolling-failed-setup.json` retains this invalid attempt separately, with no paired verdict. The
repaired shared recorder instruments the actual JS `upload` boundary or native `uploadFrame`
boundary, counting delegated uploads once and preserving dormant baseline Zig counters. Five
tracing regressions pass, including archived JS-only setup, and independent source review found
no remaining required boundary missing from the pinned runtime. Fresh bundles and provenance are
required after this benchmark-only repair; earlier proof hashes remain historical.

### Headline rolling real-history output

All four output-only windows complete: 17 terminals × 1,200 frames and one terminal × 2,700 frames,
four balanced native/xterm pairs before and after. Every one of 32 runs qualifies on the NVIDIA
hardware adapter, with no errors, page errors or process churn; idle and output GPU windows pass.
The 1,059,649-byte corpus has 259 complete-UTF-8 chunks. Per-terminal measured payloads are
4,910,340 bytes at 17 terminals and 11,047,050 bytes at one. Corpus SHA-256 is
`5b962d02c1255260d6a332719dacc083515893ed355d0aa3695f40541fc08834`; the framed-cycle hash is
`044a938134f9d0999f3d6c46ac931dea40c0d901806e3222b1ac769fda12115f`.

| Terminals | Output CPU, % of one core | Native before → final | xterm WebGL before → final |
| --------: | ------------------------- | --------------------: | -------------------------: |
|        17 | Renderer process          |       32.633 → 20.453 |            22.304 → 22.725 |
|        17 | GPU process               |       28.622 → 27.005 |            27.132 → 27.462 |
|        17 | Total                     |       61.500 → 47.707 |            49.833 → 50.328 |
|         1 | Renderer process          |         4.915 → 3.783 |              4.326 → 4.238 |
|         1 | GPU process               |         2.518 → 2.418 |              2.740 → 2.674 |
|         1 | Total                     |         7.577 → 6.324 |              7.309 → 7.168 |

Totals are computed per case before taking medians; component medians need not sum to the total.
GPU-process figures are host CPU consumption, not GPU-device execution time. Native total CPU
falls 22.4% at 17 terminals and 16.5% at one against its original JavaScript baseline.

| Terminals | Paired native/xterm target |        Before |         Final |
| --------: | -------------------------- | ------------: | ------------: |
|        17 | Renderer CPU               | 1.464621 fail | 0.876984 pass |
|        17 | Total CPU                  | 1.234104 fail | 0.934160 pass |
|         1 | Renderer CPU               | 1.138095 fail | 0.916551 pass |
|         1 | Total CPU                  | 1.057913 fail | 0.899272 pass |

All four final pairs pass both CPU targets at both counts, with at least 100 ticks per side and
resolved differences. **The realistic-output CPU criterion of beating xterm WebGL passes in this
matrix.** The paired total advantage is 6.6% at 17 terminals and 10.1% at one: a modest hardware-
and workload-specific margin, not the much larger repeating-ASCII result or a general platform
claim. The stronger aspiration of a large lead, full native-content support, and WebGPU performance
remain separate. No realistic-output input/write latency was measured; the requested 96-sample
ASCII latency matrices and their regressions remain below.

Full-window counters prove changing work: all 81,600 submitted frames across the four final
17-terminal runs and all 10,800 across the one-terminal runs are native submissions. Baseline
submits the same totals through JavaScript; its zero Zig/fallback counters are dormant. Final
fallback counters are already 68 and 4 before timing and stay unchanged during timing. This is
zero measured-window fallback, with earlier unsupported-content preparation preserved. Uploads
fall from 6,266,880,000 to 3,435,379,584 bytes at 17 and from 829,440,000 to 453,292,800 at one.
No device restoration occurs during the measured windows.

`results-rolling.json` and `rolling-{before,after}-{17,1}.json` retain exact ratios, individual ticks,
producer snapshots/deltas, raw hashes and qualifications. Before/after qualification PNGs are
byte-identical per renderer/count and were read back; they show preparation oracles, not final
rolling viewports. Scheduled rolling pixel parity is established separately by the byte oracle.
The shared recorded driver is `475a009b9c4b55b00f4b6e126f9ae884d44fd597b6ec8dcc6afcf6829cc772a5`;
`rolling-bundle-proof-v2.json` retains both runtime inventories, assets and repeated-baseline proof.

### Rolling main-thread attribution

A separate four-pair, 17-terminal rolling trace/control pass completes with all eight cases
qualified. It attributes the final producer only; it is not another before/after CPU verdict.
`main-attribution-rolling.json` retains the recording and eight trace hashes. Each traced native
terminal submits 181 native frames and copies 2,172 rows / 86,880 cells. Repetitions 0/2 perform 181
builds, 2,172 buffer writes and upload 7,554,240 bytes; repetitions 1/3 perform 185 builds, 2,220
writes and upload 7,687,104 bytes. The extra builds/uploads occur without extra submissions; their
cause is unconfirmed because retry/status decisions are not directly recorded. Per-terminal
medians are 2,196 writes / 7,620,672 bytes. xterm uniformly records 181 frames, 2,172 rows, 543
writes and 3,189,844 bytes. Native differential packing writes about 2.39× xterm's bytes and makes
4.04× its upload calls on this stream, while retaining the existing 64/96-byte layouts.

| Final rolling traced window, median across four repetitions   | Native WebGL | xterm WebGL |
| ------------------------------------------------------------- | -----------: | ----------: |
| Main-thread task union, ms                                    |      702.485 |   1,298.007 |
| Terminal work per animation frame p50, ms                     |        2.075 |      0.7275 |
| Parse operation, recorder self ms                             |       41.755 |     797.565 |
| Native frame build, recorder self ms                          |       77.643 |           — |
| Native listener row read, recorder self ms                    |       54.995 |           — |
| Native uploadFrame / xterm bufferData, recorder self ms       |       32.320 |      13.635 |
| Native submit / xterm drawElementsInstanced, recorder self ms |       17.688 |       7.985 |

Operation rows total recorder self-time, subtracting nested wrapped children while retaining
uninstrumented work such as JavaScript options and WASM inside `build`. Task-union intervals,
recorder self totals and sampled leaves are different measures; do not add across them. Component
medians also need not sum to a total median.
Tracing perturbs CPU substantially, especially instrumented xterm parsing. Ordinary untraced
windows above decide the performance result. Native's remaining frame work includes the build,
listener snapshot copies, upload calls and UI callbacks: sampled native leaves retain median
28.258 ms in `getBoundingClientRect`, 26.587 ms in `linkFrameSignature`, 10.237 ms in
`copiedFrameRow`, and 17.182 ms in `bufferSubData`. This explains why removing JavaScript instance
packing does not remove all host frame work. It identifies causes for later listener/scheduler
work, without claiming that those changes were measured or that all remaining CPU is attributed.
The realistic ordinary-window renderer/total target now passes; the trace does not promise a
larger hardware-independent lead or measure GPU-device execution.

The recorded shared driver remains `475a009b…`. After recording, the analysis-only phase whitelist
was extended to accept `rolling-logs`: analyzer SHA-256
`8b2c7e06d87f491f09e4eb34ee62c5501d37e1aec9995335e0ea5d37f0fe081d` →
`66d0a488689f1fbf7db1cc20526089cb1b0ff2e794b803f91057978b5e816bbb`.
Seventeen focused regressions pass, preserving unknown/duplicate/missing-control rejection.
No runtime, recorder, bundle, asset or timing data changed, and no timing was repeated.

Exact pre-format JSON bytes are retained outside Git under
`/work/reports/ghostty-benchmarks/plan-283/webgl-2026-10-03/originals/` beside raw evidence.
Mandatory hooks format the committed readable JSON; `provenance.json` records each original path,
original/formatted SHA-256 and parsed semantic equality. No compressed JSON duplicates are
committed. Historical inventories retain their measured identities, distinct from the later
analyzer revision and package-only CI test-discovery/native-provenance refresh.

### Integration boundary

The measured runtime and retained evidence are tied to `078645300`. A later normal merge of main
`46e47cb71` brings in stable checkout hashing and GPU-qualification compaction repairs. Runtime
`src/` and both WASM assets are unchanged; the runtime inventory remains
`a55bde72b81dec698b8e150c5cb1484b698e6d85321f6b7903e519929b161e08`.
The builder retains split effective-runtime/driver provenance as the authoritative identity.
Native checkout builds separately sample the NUL-framed `checkoutSourceSha256` diagnostic before
building; archived-runtime builds omit it before enumerating or reading checkout runtime sources.
The merged analyzer SHA-256 is
`72914cfef78e923f5106ce9df3676a8c922012a73ce7731b7d0f1bd56dc6fcb4`, distinct from both recorded
and first analysis revisions. No measurement is relabeled or repeated, and retained JSON stays
unchanged. Comparison/core/WebGL integration checks are rerun after the merge. Terminal's default-
on WebGPU change remains a separate follow-up PR; this lane does not measure that change.

### Final repeating-ASCII timing: secondary, fixture-flattered

The final differential-scroll source repeats the original paired ASCII/bytes matrix: four balanced
pairs, output plus latency, 1,200 frames at 17 terminals, 2,700 at one, and 96 samples per operation.
These runs retain their own V2 source/bundle identity. They precede the committed rolling-driver
freeze and do not stand in for the realistic-output verdict. Each count completes all eight runs
with no page errors or process churn; all eight idle GPU gates, sixteen measured GPU windows and
four between-repetition gates qualify on the NVIDIA hardware adapter. Independent recomputation
confirms all absolute medians and exact paired values/statuses/ticks.

| Terminals | Output CPU, % of one core | Native before → final | xterm WebGL before → final |
| --------: | ------------------------- | --------------------: | -------------------------: |
|        17 | Renderer process          |       28.783 → 12.083 |            15.388 → 15.263 |
|        17 | GPU process               |        25.381 → 0.424 |            24.806 → 24.498 |
|        17 | Total                     |       54.199 → 12.511 |            40.315 → 39.784 |
|         1 | Renderer process          |         3.950 → 2.053 |              2.807 → 2.818 |
|         1 | GPU process               |         2.252 → 0.344 |              2.397 → 2.385 |
|         1 | Total                     |         6.202 → 2.430 |              5.204 → 5.214 |

The near-zero GPU-process CPU is consistent with avoiding repeated unchanged submissions, not a
claim about cheaper rendering of changing output. Repetition flatters our differential renderer;
xterm continues uploading and rendering rows. GPU-process figures are host CPU, not device time.

| Terminals | Latency, ms | Native before → final | xterm WebGL before → final |
| --------: | ----------- | --------------------: | -------------------------: |
|        17 | Input p50   |         5.735 → 5.588 |            20.777 → 20.694 |
|        17 | Input p95   |       24.002 → 22.559 |            28.419 → 31.144 |
|        17 | Write p50   |       16.102 → 16.008 |            14.429 → 15.141 |
|        17 | Write p95   |       20.534 → 20.466 |            18.840 → 19.415 |
|         1 | Input p50   |         5.218 → 4.558 |              4.770 → 4.964 |
|         1 | Input p95   |       22.837 → 19.983 |            22.760 → 20.841 |
|         1 | Write p50   |        9.673 → 10.921 |            12.966 → 10.327 |
|         1 | Write p95   |       20.341 → 20.103 |            20.115 → 19.875 |

Final paired renderer/total CPU ratios are **0.804 pass / 0.317 pass** at 17 terminals and
**0.748 unresolved / 0.470 pass** at one. Three one-terminal native renderer samples have only
92–93 ticks, below the 100-tick threshold. Input p50/p95 ratios are **0.269/0.766 pass** at 17 and
**0.968/0.968 pass** at one. Write-p50 ratios are **1.058 fail** at 17 and **0.997 pass** at one.
Those are medians of individual pair ratios; passing the latter does not erase the absolute
one-terminal write-p50 increase of 1.247 ms against the earlier baseline cohort.

`results-v2.json` retains the absolute medians and raw-comparison hashes; `after-v2-{1,17}.json`
retain the exact paired values, ticks, latency arrays and qualification. The endpoint remains
on-demand compositor acknowledgement, without physical-vsync or optical-latency claims.

The separate final ASCII attribution trace completes four traced and four control repetitions per
renderer. Each traced native repetition has 3,077 state updates/builds but only 34 submissions,
374 buffer writes and 1,364,352 uploaded bytes; 179 of 180 output steps per terminal are no-ops.
xterm submits 3,077 frames, with 9,231 writes and 60,218,080 bytes. Native work still includes
36,924 copied rows and 1,476,960 copied cells. `main-attribution-v2.json` demonstrates the repeated
fixture bias; traced CPU is perturbed attribution, not the realistic-output verdict.

### Final write-latency decomposition

The samples defining final median-of-run-p50 latency retain the one-terminal absolute increase:

| Terminals | Endpoint change | Write → parse | Parse → render | Render → submit | Submit → acknowledgement |
| --------: | --------------: | ------------: | -------------: | --------------: | -----------------------: |
|         1 |       +1.247 ms |     −0.024 ms |      +1.039 ms |       −0.114 ms |                +0.343 ms |
|        17 |       −0.094 ms |     −0.013 ms |      +0.029 ms |       −0.018 ms |                −0.090 ms |

Small alignment terms complete these same-cohort decompositions; maximum residual is 0.007 ms.
All 768 final native writes contain one Zig build and one submitted frame, with no observed
fallback, retry, producer transition, earlier draw or extra submission. Inclusive packing improves
0.056 ms at one terminal and 0.005 ms at 17; the span includes JS options plus the WASM call.
The one-terminal headline shift is principally parse-to-scheduled-render wait, followed by
submit-to-acknowledgement wait, rather than more packing or additional native submissions.

Pooled mean endpoint differences are −0.322 ms at one terminal and −0.684 ms at 17; these use a
different statistic and do not replace the headline cohorts. In the approximate 14–16 ms callback
arrival-phase bin, one-terminal samples change 96 → 77, endpoint p50 is 4.309 → 3.995 ms, and
parse-to-render wait stays 0.180 ms. This supports scheduling-phase variation without establishing
a causal scheduler bug. Callback phase is approximate, with no physical-vsync or optical claim.
`write-latency-attribution-v2.json` retains 3,072 reconciled sample ledgers, 32 trace hashes, four
comparison hashes and 32 exact-presentation-ID representatives; the initial analysis data is unchanged.
Independent review reconciled every ledger and headline cohort, without rerunning the raw-trace
source-measure parser. Direct status/full-rebuild/registration telemetry was not recorded, so these
are observed build/submission routes, not native-only CPU or a new scheduling-causality proof.

### Initial write-latency decomposition

The initial write-p50 increase is retained as a regression observation, not hidden by CPU gains.
Analysis of all 3,072 native/xterm writes validates exact presentation identities, 32 trace hashes
and the actual samples defining the median-of-run-p50 statistic:

| Terminals | Endpoint change | Parse → render wait | Render → submit | Submit → acknowledgement |
| --------: | --------------: | ------------------: | --------------: | -----------------------: |
|         1 |       +2.677 ms |           +2.750 ms |       −0.099 ms |                +0.023 ms |
|        17 |       +0.634 ms |           +0.587 ms |       −0.018 ms |                +0.077 ms |

Small parse and clock-alignment terms complete the decomposition; maximum additive residual is
0.008 ms. All 768 initial-after native writes contain one build and one submitted frame, with no
observed retry, fallback, earlier draw or extra submission before acknowledgement. Baseline packing
is JavaScript `rebuildRows`; the native `build` span includes JavaScript options plus the WASM call.

The dominant difference is waiting for the next scheduled frame. One-terminal baseline run p50s
span 5.375–14.134 ms and treatment p50s span 9.687–15.810 ms. In the approximate late-arrival phase
bin, sample count changes 96 → 62 while p50 stays 4.309 → 4.213 ms. Unchanged xterm controls move
−0.535 ms at one terminal and +0.684 ms at 17, almost the native 17-terminal shift. These separate
sample cohorts and sequential screenshot-driven launches support scheduling-phase variation;
they do not establish a causal renderer scheduling bug. No confirmed fixable latency-source bug
was found. The repeated markers contain no newline or wrap, so the rolling-scroll fix is separate.
No direct native-only timing, scroll/full flag, physical presentation or optical latency is inferred.
`write-latency-attribution.json` preserves the event sequences, ledger and limitations.

## Bounded-upload experiment, Linux 2026-10-02

**Not merging: no CPU gain.** Coalescing native WebGPU uploads reduces API crossings but does not
clear the owner's complexity bar. This remains a draft experiment; the full native-frame move
still fails its total-CPU gate. The useful outcome is the retained GPU-process attribution.

The candidate independently coalesces persistent WASM cell and glyph ranges across individual gaps
of at most 4 KiB. Distant edits retain narrow changed-record uploads. An unbounded first-to-last
span was rejected by an upload-only hardware probe: opposite-corner edits in a 200×100 grid sent
320 bytes in four writes, versus 3.2 MB in two writes; average queue completion was approximately
0.21 versus 4.02 ms. This probe draws nothing and carries no CPU or presentation verdict. The
selected cap applies to each gap, not the total clean bytes across a chained batch.

The candidate also skips GPU submission for unchanged successful native frames while settling
damage and callbacks. Renderer and benchmark upload-byte counters read the text pass's actual
written-byte delta; a fragmented fixture sends 5,440 bytes, including clean gaps, rather than its
1,920 logical changed bytes. Real GPU regressions check destination buffers, source WASM offsets,
changed records, two writes for twelve rows, and unchanged-frame callback/damage settlement.

### Ordinary paired timing

Before and after use separate frozen bundles. Each native/xterm pair stays in one browser session:
ASCII/bytes, four balanced repetitions, output plus latency, 96 samples per operation/repetition.
17 terminals use 1,200 output frames; one terminal uses 2,700. Every ordinary run and measured GPU
window qualifies, all CPU target pairs exceed the 100-tick and one-tick-difference thresholds, and
page-error arrays are empty. These are hardware-adapter headless-shell measurements. Latency ends
at on-demand compositor acknowledgement of the submitting frame, with no physical-vsync or
optical-latency claim. Separate prototype/Dawn traces are perturbed attribution, not CPU timing.

| Terminals | Output CPU, % of one core | Native before → after | xterm WebGL before → after |
| --------: | ------------------------- | --------------------: | -------------------------: |
|        17 | Renderer                  |       18.293 → 18.344 |            15.342 → 15.534 |
|        17 | GPU process               |       60.168 → 59.906 |            24.307 → 25.068 |
|        17 | Total                     |       78.263 → 78.653 |            39.699 → 40.652 |
|         1 | Renderer                  |         3.550 → 3.340 |              2.818 → 2.730 |
|         1 | GPU process               |         5.891 → 5.932 |              2.463 → 2.264 |
|         1 | Total                     |         9.441 → 9.254 |              5.270 → 5.026 |

Absolute medians show no material total-CPU improvement at either size. The optimized paired
renderer/total ratios remain **1.175/1.922× at 17 terminals** and **1.241/1.887× at one terminal**,
all failed. These are medians of individual pair ratios, not ratios of the table's medians.

| Terminals | Latency, ms | Native before → after | xterm WebGL before → after |
| --------: | ----------- | --------------------: | -------------------------: |
|        17 | Input p50   |       20.099 → 20.248 |            20.561 → 20.538 |
|        17 | Input p95   |       28.341 → 28.849 |            27.160 → 28.701 |
|        17 | Write p50   |       15.694 → 16.262 |            15.294 → 14.878 |
|        17 | Write p95   |       20.448 → 20.642 |            19.414 → 18.980 |
|         1 | Input p50   |         4.750 → 5.309 |              4.612 → 4.760 |
|         1 | Input p95   |       20.423 → 29.665 |            20.985 → 20.983 |
|         1 | Write p50   |       12.848 → 11.869 |              7.526 → 9.079 |
|         1 | Write p95   |       20.113 → 20.444 |            19.924 → 19.881 |

The one-terminal input tail worsens; all five optimized one-terminal paired targets fail. The
stored p95-nearest input samples place 18.565–27.115 ms before parse completion, 0.295–0.430 ms
between parse and submission, and 2.123–4.693 ms between submission and acknowledgement. That
quick pattern does not establish a missed frame or its cause; indirect scheduling regression is
not ruled out. No deep latency follow-up or new latency-only run is claimed.

### Upload call reduction without CPU reduction

A separate four-repetition ASCII trace records 5,117 submitted terminal frames per case. Native
`writeBuffer` calls fall from 122,808 to 10,234: **24 → 2 per submitted terminal frame**. Actual
bytes stay at 392,985,600 per case, **76,800 per terminal frame**. Warm atlas writes are zero.

Texture/view acquisition, encoder creation, pass begin/end, encoder finish and submission remain
one each per terminal frame; pipelines, bind groups and full-grid draws remain two each. These
are 13 fixed WebGPU method calls, so this census falls from 37 to 15 total calls per terminal
frame. Unchanged successful native frames avoid those submission-related calls. Encoders,
passes and swapchain views cannot be retained indiscriminately across presented frames.

Median upload-wrapper inclusive time falls from 160.010 to 129.818 ms. GPU-process inclusive
`DawnCommands` falls 1704.305 → 1649.801 ms, `WebGPUDecoderImpl::HandleDawnCommands`
1694.723 → 1640.324 ms, and `CommandBuffer::Flush` 2896.133 → 2818.108 ms. Nested durations
overlap and must not be summed. These window-clipped host events are neither CPU samples nor
GPU-device execution time, and the traced windows need not contain every later compositor task.
Their modest change does not establish a material output-CPU gain. `DawnCommands` event counts
stay approximately three per submit: median 15,356 → 15,359.5 over 5,117 native submits. Fewer JS
`writeBuffer` calls therefore do not demonstrate fewer GPU-process Dawn command batches. The
trace does not qualify an exact packet-to-API or packet-to-canvas mapping.

### Fresh same-session WebGPU, native WebGL and xterm GPU seams

A separate balanced three-way ASCII/bytes trace uses the final WebGPU/Zig candidate, our native
WebGL renderer with its JS frame builder, and xterm WebGL in browser session
`1ef45499-1b35-4cb9-acb0-81f4dd1ec01e`. All 12 runs and 24 measured GPU windows qualify. Four
repetitions per renderer each contain 5,117 actual terminal render/submission boundaries. This
compares the existing implementations; it does not isolate the graphics API from the builder.

Values below are medians of repetition-normalized **inclusive GPU-process host microseconds per
observed terminal render**. They evenly divide a shared process window, not an isolated canvas
cost. Event names overlap: do not add them or interpret them as GPU-device execution.

| Exact event                                     | WebGPU/Zig | Native WebGL/JS | xterm WebGL |
| ----------------------------------------------- | ---------: | --------------: | ----------: |
| `Scheduler::RunTask`                            |    654.963 |         268.676 |     262.995 |
| `GpuChannel::ExecuteDeferredRequest`            |    582.503 |         171.152 |     166.562 |
| `CommandBuffer::Flush`                          |    575.795 |         160.518 |     156.752 |
| `SkiaOutputSurfaceImplOnGpu::BeginAccessImages` |      4.357 |          46.879 |      40.493 |
| `SkiaOutputSurfaceImplOnGpu::SwapBuffers`       |     60.012 |          41.430 |      43.840 |
| `Display::DrawAndSwap`                          |      8.284 |           8.289 |      10.882 |
| `GLContextEGL::MakeCurrent`                     | Unobserved |           3.454 |       4.124 |
| `SyncToken::Wait`                               |      0.011 |           0.198 |       0.199 |

WebGPU also exposes `DawnCommands` at 333.509 µs/render and
`WebGPUDecoderImpl::HandleDawnCommands` at 331.600 µs/render, with approximately 3.002 events
per submit. These are nested within command handling. The largest observed difference is there,
not a uniformly larger compositor/image-access cost. Wait durations describe observed host
intervals; missing native operation names cannot establish absent device waits or internal copies.

GPU `RunTask` all-thread temporal-union medians are 3487.875 / 1414.015 / 1380.384 ms per window
(WebGPU / native WebGL / xterm); corresponding `CrGpuMain` thread unions are
3444.841 / 1405.067 / 1369.719 ms. Neither union measures CPU consumption or device time.
Native WebGL and xterm are close in this trace, while WebGPU's main-thread interval is about
2.45× native WebGL's. This supports measuring WebGL as the Linux default next for this
Linux/Chromium/Vulkan configuration. No fresh untraced native-WebGL CPU/latency comparison or
cross-platform default verdict is claimed. It does not prove that one shared WebGPU canvas removes
the excess: no canvas-consolidation treatment was run. GL's many observed context IDs coexist with
lower host work, so context/canvas multiplicity alone is not a demonstrated cause.

Fresh inclusive synchronous upload-wrapper medians are 127.980 / 29.165 / 20.810 ms per window.
WebGPU writes 76,800 bytes/render; xterm's wrapper records 19,610.897 bytes/render. Native WebGL
observes two `bufferSubData` calls/render, but its wrapper bytes are unavailable and its direct
byte counter's zero is unqualified instrumentation coverage, not zero-upload evidence. Xterm's
direct prototype counters are unavailable; renderer markers provide its three uploads and draws.
Exact GPU-process implementation time for `getCurrentTexture` remains unobservable.

Context arguments need event-specific interpretation. WebGPU's two `context` values belong only
to `EpollEvent`, not GPU devices or canvases. Native WebGL exposes 17/18/18/17 distinct
`GLContextEGL::MakeCurrent` context values by repetition; xterm exposes 17 each. For repetition 0,
native GL has 385–393 calls/ID and 0.565–1.479 ms inclusive/ID; xterm has 368–379 and
0.952–2.069 ms. No terminal-to-context mapping is qualified, and no Dawn context/channel/
command-buffer identifier is exposed. Shared-process averages cannot answer true per-canvas cost.
Exact event counts, thread strata, argument examples and ID distributions are retained in
[three-way-gpu-seams.json](benchmarks/linux-one-write-2026-10-02/three-way-gpu-seams.json).

Evidence, exact ratios, individual ticks, qualification, manifests, sparse decision samples and
read-back smoke screenshots live in [the experiment evidence](benchmarks/linux-one-write-2026-10-02/).
The before/after 17-terminal smoke PNGs are byte-identical; existing ZWJ-width observations remain
tracked in #360. Raw artifacts stay in `/work/tmp/plan283-one-write/`. Focused checks pass: 29 unit,
31 browser plus two existing Linux skips, four tracing regressions, build/typecheck and root gates.
The full package test suite was not rerun; no production deployment or merge was performed.

## Linux hardware comparison instrument

The Linux runner measures native WebGPU and xterm WebGL in the same Chromium headless-shell session over secure loopback HTTP. It enables Vulkan with `--enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist`, records CDP GPU feature status and the WebGPU adapter, and rejects software/fallback adapters. Adapter acquisition retries up to three times, 100 ms apart. macOS retains headed Chromium and its AC-power/caffeinate checks. Full Chromium headless on the RTX 3060 Ti exposed the NVIDIA adapter but captured a black WebGPU canvas; the same minimal red-canvas diagnostic visibly rendered on headless-shell. This harness selection requires no terminal-library change.

Latency now ends at `AnimationFrame::Presentation` for the exact animation-frame identity containing the terminal's actual GPU submission. Selection requires the operation's parse span, input echo receipt for keystrokes, and `submit` or `drawElementsInstanced` inside the render span. A deferred draw callback with no submission cannot qualify. The first colored-glyph PNG remains a correctness check and capture-timing diagnostic. Missing presentation feedback fails the case; there is no PNG timestamp fallback. Normal latency tracing omits the V8 CPU profiler, and the review-repair hardware runs collect 96 samples per operation and repetition.

**Linux headless-shell measures keydown/write to compositor presentation acknowledgement, on-demand, not physical vsync.** Its renderer rAF period is approximately 16.665 ms, while presentation feedback follows submission asynchronously. Physical-display frame drops and optical latency remain unmeasured. The optional `--validate-presentation` phase inserts one rAF before write and retains 24 delayed samples, allowing renderer-frame sensitivity to be checked separately. These values must not be compared directly with the historical captured-PNG Mac values below.

NVIDIA qualification waits for three consecutive samples at or below 5% utilization before each window and between repetitions, with a 30-second give-up. Timed-out idle samples retry within that budget and reset the consecutive-sample count. During measurement it rejects utilization above 80%, foreign compute residency above 1024 MiB, or any new foreign compute PID relative to the final qualified idle sample. The benchmark browser's CDP process IDs are excluded from foreign residency; total GPU utilization includes benchmark load. Before/after samples are mandatory. Idle qualification and short parser/burst windows use 250 ms polling; CPU and latency windows use 1000 ms polling to reduce sampler perturbation. Commands have a 2-second timeout, bounded by the remaining idle-wait budget. Missing NVIDIA tooling/devices or other platforms retain explicit skip reasons in runs, paired rows and markdown. Resident memory is a conservative activity proxy, and subinterval bursts may be missed. All thresholds are named fixture settings.

Native/xterm cases run adjacent across four balanced repetitions (native/xterm, xterm/native, xterm/native, native/xterm). CPU renderer/total and input p50/p95/write p50 targets use the **median of individual native/xterm pair ratios**, with target ≤ 1. Each pair requires matching browser-session UUID, pair ID, repetition, path and count. Missing, duplicate, failed or GPU-disqualified partners yield incomplete targets. CPU time resolution is recorded from Linux `CLK_TCK` (10 ms on this host). A CPU pair and its row are **unresolved** if either side has fewer than 100 ticks or sides differ by at most one tick. Zero/zero never passes; unbounded ratios are JSON null with an explicit reason. Absolute values are context; ratios of independently aggregated medians are not the pass rule. Raw traces, glyph checks, window GPU samples and individual pair values remain in the run artifacts.

Tracing instrumentation is loaded in **every hardware run**, including CPU and burst windows. Inactive pass-through wrappers and their call counts differ between native and xterm. These values are distinct from earlier non-instrumented runs; no wrapper-overhead correction is applied.

### Qualified Linux proof, 2026-10-02

The review-repair runs completed all eight cases per quiet window on Chromium headless-shell 153.0.8010.12, RTX 3060 Ti / NVIDIA 610.57.4 / Vulkan, with identical benchmark source and bundle hashes. Each count has a separate browser-session UUID; every pair stays within one session. ASCII/bytes, counts 1 and 17, four balanced repetitions, 96 input and 96 write samples per renderer/repetition. Count 1 uses 2700 paced output frames (approximately 45 seconds); count 17 uses 1800 (approximately 30 seconds). The reduced latency sample count keeps each complete quiet run below ten minutes: 585.124 seconds at count 1 and 468.535 at count 17. Output renderer samples contain 118–201 and 454–993 CPU ticks respectively; tick size is 10 ms. The earlier short-window CPU ratios are superseded.

All adapters are non-fallback, all GPU windows and all four between-repetition GPU qualifications per count passed, no qualification was skipped, and all page-error arrays are empty. Maximum observed GPU utilization was 16% at count 1 and 67% at count 17. The four correctness screenshots were read back; ASCII, SGR, CJK and overwrite are visible throughout, with the existing native/xterm emoji shaping difference.

Compact evidence retains all latency arrays, CPU denominators/process splits and tick size, individual ratios and statuses, adapter/feature status, GPU-window ranges/settings, all qualification records, hashes and representative input traces: [1 terminal](benchmarks/linux-nvidia/2026-10-02-comparison-1.json), [17 terminals](benchmarks/linux-nvidia/2026-10-02-comparison-17.json). Raw traces and per-sample GPU observations remain in `/work/tmp/plan-283-linux/review-clean-{1,17}/`. Source SHA256 at bundle creation: `73d0eee02e631cf302f5f28e983bb7835908fe03509975b87c4ec5f3f69a7e23`. The builder hashes the `git ls-files --cached --others` listing in emitted order: staging the new compactor moves its entry and changes that aggregate hash without changing source bytes. Replaying the original order reproduces this hash; every shipped runtime script was also independently byte-hash compared with the committed source.

| Median individual native/xterm ratio (target ≤ 1) |        1 terminal |      17 terminals |
| ------------------------------------------------- | ----------------: | ----------------: |
| Idle renderer CPU                                 | null — unresolved | null — unresolved |
| Idle total CPU                                    | null — unresolved | null — unresolved |
| Output renderer CPU                               |      1.552 — fail |      2.101 — fail |
| Output total CPU                                  |      2.097 — fail |      2.294 — fail |
| Input p50                                         |      1.044 — fail |      0.960 — pass |
| Input p95                                         |      1.057 — fail |      0.965 — pass |
| Write p50                                         |      1.075 — fail |      1.071 — fail |

Idle CPU remains **unresolved** because the samples are below the minimum tick count. Zero/zero has a null ratio with a reason and never passes. Resolved ratios above 1 remain failed targets; this instrument pass makes no product-speedup claim. These longer-window measurements change the output CPU conclusions from the superseded low-resolution run. Every serialized aggregate ratio and status was independently recomputed from the compact evidence.

Count 1 absolute latency, milliseconds:

| Pair | Renderer | Input p50 | Input p95 | Write p50 |
| ---- | -------- | --------: | --------: | --------: |
| 1    | native   |     5.407 |    25.416 |    13.878 |
| 1    | xterm    |     4.740 |    20.494 |    15.370 |
| 2    | native   |     5.009 |    22.225 |    15.308 |
| 2    | xterm    |     4.816 |    21.612 |    13.922 |
| 3    | native   |     5.056 |    23.000 |    13.131 |
| 3    | xterm    |     4.851 |    21.181 |    12.500 |
| 4    | native   |     5.284 |    27.758 |    16.133 |
| 4    | xterm    |     5.050 |    27.201 |     7.569 |

Count 1 output CPU, percent of one core:

| Pair | Renderer | Renderer process | GPU process | Browser |  Other |  Total |
| ---- | -------- | ---------------: | ----------: | ------: | -----: | -----: |
| 1    | native   |            4.016 |       6.012 |   0.000 |  0.000 | 10.028 |
| 1    | xterm    |            2.618 |       2.108 |   0.000 |  0.022 |  4.749 |
| 2    | native   |            4.461 |       6.236 |   0.022 | -0.000 | 10.719 |
| 2    | xterm    |            2.841 |       2.264 |   0.000 |  0.000 |  5.104 |
| 3    | native   |            4.305 |       5.991 |   0.022 | -0.000 | 10.318 |
| 3    | xterm    |            2.707 |       2.219 |   0.000 | -0.000 |  4.926 |
| 4    | native   |            4.082 |       5.747 |   0.000 | -0.000 |  9.829 |
| 4    | xterm    |            2.685 |       2.086 |   0.022 | -0.000 |  4.793 |

GPU-process CPU is CPU consumption, distinct from GPU hardware execution time. The pair 1 median-nearest input samples show native keydown → echo receipt +0.443 ms → parse end +0.485 → render start +0.731 → submission end +0.885 → presentation ack +5.391. xterm shows +0 → +0.425 → +0.490 → +0.953 → +1.005 → +4.735. Submission-to-ack is 4.506 versus 3.730 ms. Both parse-to-render intervals are submillisecond; this sample does not support the earlier large parse-to-render-wait narrative. A representative sample locates intervals and establishes no general scheduling cause.

The deliberately delayed write phase raises native write p50 from 13.878 to 28.965 ms (+15.087), and xterm from 15.370 to 30.984 ms (+15.615), with 24 delayed samples each versus 96 ordinary samples. Both respond to an extra renderer rAF (period approximately 16.665 ms); differing baseline/delayed phase distributions prevent an exact-period delta claim. Headless feedback remains on-demand and supplies no physical-display latency evidence.

Reproduce each count from the portable bundle through an exclusive quiet benchmark window, selecting `--counts 1 --output-frames 2700` or `--counts 17 --output-frames 1800`, plus `--paths bytes --fixtures ascii --repetitions 4 --latency-samples 96`. Count 1 also selects `--validate-presentation`. Generate compact evidence with committed code:

`node ghostty-webgpu/scripts/comparison-compact.mjs <run-directory>/comparison.json <compact-output.json>`

The compact generator retains preparation failures and missing metrics, so incomplete runs remain incomplete. Unbounded ratios serialize as null with a reason. No macOS rerun or product deployment accompanies these benchmark-only repairs.

## Conclusions and target reproducibility

The corrected baseline is [benchmarks.md](benchmarks.md), from Fregat PR #235. This investigation preserves the CPU disadvantage at 17 terminals, identifies renderer-side snapshot/instance work, and does **not** reproduce the one-terminal input-p95 disadvantage.

| Target                         |     PR #235 native / xterm | This run native / xterm | Measured conclusion                                                                                                           |
| ------------------------------ | -------------------------: | ----------------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| ASCII output CPU, 17 terminals | 100.1% / 89.9% of one core |        106.77% / 86.72% | Native renderer CPU is higher; native GPU-process CPU is lower.                                                               |
| Input echo p95, 1 terminal     |             46.2 / 32.1 ms |        28.83 / 39.75 ms | Native disadvantage did not reproduce. Plan 283's target table may change.                                                    |
| Write p50, 1 terminal          |              14.0 / 8.2 ms |        17.01 / 12.24 ms | Median-of-run gap is 4.77 ms, with overlapping/reversed individual runs. Frame/capture phase dominates the measured endpoint. |

The new summary values are medians of three run-level statistics from **inactive-wrapper controls**. Absolute values are subject to the geometry and instrumentation limitations below. Captured-glyph latency ends at the first compositor screencast PNG containing the intended colored glyph. It is distinct from Chrome presentation feedback and optical display latency.

## Ranked causes and candidate fixes

Shares below use **all measured renderer-main task time** in traced output phases, including the residual outside wrapped boundaries. They are measurements of this workload, not predicted CPU savings.

| Rank / target         | Measured cause                                  | Evidence at 17 terminals                                                                                                                                                                | Proposed next step                                                                                                                                                                                            | Complexity                                                         |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 / output            | Snapshot extraction and JS cell materialization | 49.35% of main tasks for ASCII; 59.25% for SGR. Sampled `get view` leaf time alone is about 11.94% / 15.46% of main tasks, inside this stage.                                           | First test reusing `DataView` and typed memory views while `memory.buffer` identity is unchanged; refresh them after growth. Only consider a bulk snapshot ABI if that simple change leaves substantial cost. | Low for view reuse; medium for ABI/data-layout changes.            |
| 2 / output            | Instance building                               | 26.82% ASCII; 15.61% SGR. Warm glyph/key/color lookup and cell/glyph packing occur here.                                                                                                | Measure and streamline the warm instance path, preserving cell semantics and damage behavior. The trace does not establish a single winning substep.                                                          | Medium.                                                            |
| 3 / output            | JS residual and uninstrumented browser work     | Wrapped JS: 10.20% / 8.79%; uninstrumented residual: 6.12% / 5.98%.                                                                                                                     | Drill down only after snapshot/instance changes; separate recorder overhead from library work.                                                                                                                | Low instrumentation; fix depends on the finding.                   |
| 4 / output            | Buffer upload                                   | 4.16% / 3.67%; 76,800 bytes per native terminal render. Steady-state atlas uploads are zero.                                                                                            | Consider smaller instance uploads only after measuring a row/layout change.                                                                                                                                   | Medium.                                                            |
| Low priority / output | VT parser, damage, command encoding/submission  | ASCII parser 1.33%, damage 0.38%, commands 1.64%. SGR parser 4.89%, damage 0.32%, commands 1.49%.                                                                                       | These are not the first optimization targets. Device sharing/batching needs fresh evidence after the renderer-side work is reduced.                                                                           | Medium/high for device lifecycle and batching.                     |
| 1 / input             | Waiting for renderer frame delivery             | Representative native p95 input: 31.31 ms from parse end to render start, 78.9% of its 39.69 ms captured latency. xterm exhibits the same two-refresh wait.                             | Keep the input target conditional on reproduction; distinguish terminal scheduling from Chromium frame delivery and capture. No native scheduler fix is justified yet.                                        | Low/medium for further instrumentation; product redesign unproven. |
| 2 / input             | Render-to-capture waiting                       | Same sample: 7.20 ms, 18.1%. Terminal work is 0.565 ms.                                                                                                                                 | Stabilize/characterize the capture endpoint before assigning the historical p95 gap to terminal code.                                                                                                         | Low/medium investigation.                                          |
| 1 / write             | Capture/frame phase                             | Representative native middle write: render finishes at +0.465 ms; glyph capture is +10.860 ms. The post-render interval is 95.7% of this sample. Other repetitions enter a later frame. | Preserve paired endpoint/timeline measurements before choosing a write-latency product fix. Snapshot/instance optimization addresses measured output work, but does not explain the entire control write gap. | Low/medium investigation.                                          |

The dominant output problem is the **snapshot/instance data boundary and layout**, not demonstrated GPU saturation. `src/core/memory.ts` constructs a new view in each `view`/`bytes` getter; cell reads use these views and multiple WASM ABI getters. That source observation and sampled leaf evidence make view reuse the smallest first experiment. No change or after-speedup is claimed here.

## Hardware, qualification, and window geometry

Authoritative measurements ran on the owner's Apple M1 MacBook Air, Darwin 25.4.0 arm64, headed Chromium 153.0.8010.12, Playwright 1.63.0, and ANGLE Metal on Apple M1. WebGPU and WebGL were hardware enabled. Each separate count window checked `pmset -g batt` for AC power and ran under `caffeinate -d -u -t 1800`. Windows took approximately 5–7 minutes each, below the 30-minute bound.

Qualification measures the **idle display**, immediately before terminals mount on the same measured page/window. The runner brings the page to front, warms up for 1 second, samples 120 rAF intervals with an 8-second deadline, and requires visibility `visible` plus a median within ±10% of 16.67 ms. Occasional skipped frames and p95 around 33 ms are accepted. Focus, visibility, intervals, bounds, page/count/phase identity, and errors are saved before the assertion. A rejected idle window keeps its qualification diagnostics and discards its timing data. Mounted/streaming cadence is workload evidence and never a display rejection criterion.

| Terminals | Empty-page probes |  Idle median range | Maximum mounted-probe median | Result    |
| --------: | ----------------: | -----------------: | ---------------------------: | --------- |
|         1 |                 6 | 16.6725–16.6875 ms |                    16.945 ms | Qualified |
|         8 |                 6 | 16.6725–17.5450 ms |                    17.510 ms | Qualified |
|        17 |                 6 | 16.6700–16.6825 ms |                   16.9325 ms | Qualified |

Each window retains 48 probes: six idle-display probes and 42 mounted-workload probes. All phase error fields are empty. Earlier rejected rehearsals supply no timing conclusions in this document.

The native display is 1440 × 900 CSS pixels at DPR 2. The physical window is positioned at (16,16), outer 1408 × 868, with content 1408 × 781. The original 17-terminal grid is 1544 × 1332 and cannot fit at full scale. A compositor-placement CSS transform fits **both** libraries on-screen: scale 1 at count 1, 0.90673575 at count 8, and 0.58033033 at count 17. Logical host dimensions, 40 columns × 12 rows, bundled JetBrains Mono regular/bold, 12 px font, line-height 1.2, and every terminal's 560 × 456 canvas backing dimensions stay unchanged. The runner checks backing dimensions before/after fitting and checks every transformed terminal rectangle.

This changes physical compositor area and presentation geometry relative to PR #235. It limits absolute cross-run CPU/capture comparisons; the library-side snapshot, instance, and ownership observations remain directly measured. Native and xterm screenshots at all counts are in the evidence directory; they were read back for visible output and on-screen placement. Linux SwiftShader smoke supplies correctness evidence only, with no timing claims.

## CPU by Chromium process

### Correction after review

The original v4 CPU numerator spanned two process snapshots, but its denominator covered only the operation between them. In traced phases, recorder activation sat between the first snapshot and the operation timer. Those intervals differ. **The original v4 CPU percentages and trace/control CPU ratios are unqualified and withdrawn from the conclusions.** The original 17-terminal ASCII controls reported 109.19% native and 88.75% xterm. Their archives contain neither snapshot acquisition timestamps nor matching CDP events; the exact interval cannot be reconstructed. The compact v4 rows now explicitly carry `cpuIntervalQualified: false`. Their independent renderer-main task shares, counters, and captured latency samples remain usable.

The replacement is a narrow headed M1 rerun of 17-terminal ASCII, three repetitions with alternating control/trace order, on AC under `caffeinate -d -u -t 1500`. It ran from 12:10:10.926 to 12:13:27.609 UTC. All six cases, twelve phases, and 24 display probes completed without run, page, or phase failures. Six idle medians span 16.6700–16.8725 ms; the largest mounted median is 17.1250 ms. The original on-screen geometry, terminal dimensions, real GPU, browser version, and fixtures are retained. Both replacement screenshots were read back.

Recorder activation now precedes the first CPU snapshot. Each snapshot retains its CDP request and response timestamps. CPU is `SystemInfo.getProcessInfo` CPU-time delta divided by the midpoint-to-midpoint interval of those acquisition brackets; operation duration is stored separately. CDP supplies no exact internal acquisition timestamp, so midpoint timing is an estimate with explicit uncertainty: half the combined request/response bracket widths. Across this rerun that uncertainty is 0.371–0.862 ms on intervals of 3062.7–3090.1 ms (less than 0.029%). This bounds clock acquisition uncertainty; it is not a correction for workload or profiling perturbation. Process births/exits still reject a sample.

Percentages are percent of one core. Renderer includes all renderer-process CPU. GPU-process CPU is CPU consumption in that process, **not GPU hardware execution time**. Columns are independently aggregated medians and need not sum exactly.

| ASCII, 17 terminals | Native total | Native renderer | Native GPU process | xterm total | xterm renderer | xterm GPU process |
| ------------------- | -----------: | --------------: | -----------------: | ----------: | -------------: | ----------------: |
| Controls            |       106.77 |           80.66 |              25.86 |       86.72 |          49.31 |             37.23 |
| Traced              |       114.90 |           86.09 |              28.45 |       96.29 |          61.40 |             35.01 |

Control totals by repetition are native 106.19, 106.77, 107.14%; xterm 86.72, 97.79, 85.86%. The corrected median gap is 20.05 percentage points. Native excess remains renderer-side, while native GPU-process CPU is lower. This rerun replaces only 17-terminal ASCII CPU; 1/8-terminal and SGR CPU figures have not been remeasured. The differences from v4 include ordinary run-to-run variation as well as the interval repair, so the numerical change cannot be assigned solely to that repair.

### Tracing perturbation

Trace/control order alternates by repetition. Wrappers are installed on `?trace` pages but recording is inactive in controls, so these are not default no-wrapper controls. Chrome tracing, CPU sampling, method wrapping, counters, and span allocation perturb the workload. In this corrected run, total medians rise from 106.77 to 114.90% native and 86.72 to 96.29% xterm, while xterm GPU-process CPU falls from 37.23 to 35.01%. A universal positive overhead subtraction is invalid. Use controls for comparative CPU and traces for attribution; do not multiply a traced stage share by control CPU to predict savings.

The corrected ASCII trace independently confirms the stage ranking: native snapshot 49.14%, instances 27.16%, parsing 1.31%, and residual 5.93% of 7017.70 ms summed renderer-main tasks. The full 1/8/17 stage matrix below is the original v4 task-time evidence, whose denominator does not use process CPU sampling.

## Exclusive renderer-main task attribution

`comparison-attribution.mjs` aligns the `compare/begin` UserTiming timestamp with its `performance.now` time, selects that renderer's main pid/tid, clips complete `RunTask` intervals to the recording window, and unions overlaps. Nested wrapper spans subtract child duration from parent self-time. The tables divide summed category self-time across three repetitions by summed whole-main task time. Residual includes unwrapped browser work, GC, and recorder overhead outside boundaries. `summary.shares` in raw records has a different, instrumented-only denominator and is not used for these tables.

### Native shares, percent of whole main tasks

| Output | Count | Parse | Snapshot/copy | Damage | Instances | Upload | Commands |    JS | Residual | Main-task ms, 3 runs |
| ------ | ----: | ----: | ------------: | -----: | --------: | -----: | -------: | ----: | -------: | -------------------: |
| ASCII  |     1 |  1.00 |         55.16 |   0.24 |     17.09 |   2.49 |     1.37 |  7.90 |    14.75 |              1870.64 |
| ASCII  |     8 |  1.21 |         49.87 |   0.38 |     25.17 |   3.82 |     1.58 | 10.04 |     7.93 |              4046.85 |
| ASCII  |    17 |  1.33 |         49.35 |   0.38 |     26.82 |   4.16 |     1.64 | 10.20 |     6.12 |              7163.94 |
| SGR    |     1 |  4.41 |         51.52 |   0.34 |     13.02 |   3.17 |     1.65 |  9.44 |    16.46 |              1657.32 |
| SGR    |     8 |  4.70 |         58.26 |   0.33 |     15.16 |   3.61 |     1.46 |  8.64 |     7.83 |              4160.41 |
| SGR    |    17 |  4.89 |         59.25 |   0.32 |     15.61 |   3.67 |     1.49 |  8.79 |     5.98 |              7565.66 |

### xterm shares, percent of whole main tasks

| Output | Count | Parse | Model/instances | Damage | Upload | Commands |   JS | Residual | Main-task ms, 3 runs |
| ------ | ----: | ----: | --------------: | -----: | -----: | -------: | ---: | -------: | -------------------: |
| ASCII  |     1 | 44.79 |            4.21 |   0.36 |   1.28 |     1.06 | 2.92 |    45.38 |              1185.77 |
| ASCII  |     8 | 66.56 |            5.26 |   0.19 |   1.20 |     0.93 | 2.33 |    23.52 |              2360.77 |
| ASCII  |    17 | 70.48 |            5.19 |   0.20 |   1.25 |     0.87 | 2.37 |    19.65 |              4010.12 |
| SGR    |     1 | 48.28 |            4.31 |   0.32 |   1.26 |     1.07 | 2.69 |    42.08 |              1224.18 |
| SGR    |     8 | 70.14 |            4.47 |   0.14 |   1.08 |     0.80 | 1.95 |    21.41 |              2465.44 |
| SGR    |    17 | 71.23 |            4.53 |   0.15 |   1.17 |     0.81 | 2.04 |    20.07 |              4385.55 |

### Boundaries and sampled drill-down

| Category      | Native boundary                                                 | Pinned xterm WebGL boundary                   |
| ------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Parse         | Exact `ghostty_terminal_vt_write` WASM call                     | Input handler `parse`                         |
| Snapshot/copy | Render-state `update` and `readRows`                            | `_updateModel`, including model/instance work |
| Damage        | `rowsToRebuild` and state `acknowledge`                         | Render service `refreshRows`                  |
| Instances     | `rebuildRows`, excluding nested snapshot calls                  | Included in `_updateModel`                    |
| Upload        | Text pass `upload`, atlas `sync`                                | `bufferData`, `texImage2D`                    |
| Commands      | Text pass `submit`                                              | `drawElementsInstanced`, explicit `flush`     |
| JS            | Exclusive core/DOM `write`, `notifyWrite`, `drawFrame` residual | Exclusive `write`, `renderRows` residual      |

WASM ABI getters during cell extraction belong to snapshot, not VT parsing. xterm combines model and instance work, so its model share is not a matching native snapshot-only boundary. Private pinned xterm methods fail immediately if missing.

Chrome sampled profiles join `ProfileChunk` events by renderer pid and profile identity; chunks arrive on sampler threads. Native `get view` leaf estimates across three repetitions are 855.49 ms ASCII / 1169.76 ms SGR at count 17, and 556.67 / 636.27 ms at count 8. These are sampling estimates inside the snapshot path, not exact boundary durations or extra shares to add to the table. Function-name leaf aggregation cannot fully separate identically named functions or attribute all GC.

## Per-terminal/render counts and resource ownership

Each output phase has 180 paced writes. The clear/settle render adds one: each terminal has 181 renders per repetition, or 543 across three repetitions. Counts remain consistent at 1, 8, and 17 terminals. Compact analyses preserve terminal-specific distributions of exact counter combinations; full archives preserve each raw timestamped count and frame.

| Observable per terminal render     |         Native |                  xterm WebGL |
| ---------------------------------- | -------------: | ---------------------------: |
| State/model updates                |              1 |                            1 |
| Copied/model rows                  |             12 |                           12 |
| Copied cells                       |            480 | Unavailable at this boundary |
| Buffer writes                      |              2 |                            3 |
| Buffer bytes, ASCII average        |         76,800 |                    19,570.39 |
| Buffer bytes, SGR average          |         76,800 |                    10,425.19 |
| Draws                              |              2 |                            3 |
| WebGPU queue submissions           |              1 |    Unavailable through WebGL |
| Explicit GL flushes                | Not applicable |                   0 observed |
| Steady-state atlas uploads / bytes |          0 / 0 |                        0 / 0 |

xterm's first clear frame uploads 1280 bytes; full steady ASCII/SGR frames upload 19,672 / 10,476 bytes. Native counts are fixed in these fixtures. These values count API upload bytes, not downstream driver copies. Atlas initialization happened before recording; zero warm uploads does not mean zero atlas memory or zero glyph-cache lookup cost.

At count 17, native aggregate work for one shared rendering group is 17 state updates, 204 rows, 8160 cells, 34 buffer writes, 1,305,600 uploaded bytes, 34 draws, and 17 queue submissions. Across three output repetitions there are 9231 terminal renders for either library; count 8 has 4344 and count 1 has 543.

| Count | Native schedulers / devices / queues / pipelines | xterm debouncers / GL contexts / programs |
| ----: | ------------------------------------------------ | ----------------------------------------- |
|     1 | 1 / 1 / 1 / 2                                    | 1 / 1 / 2                                 |
|     8 | 8 / 8 / 8 / 16                                   | 8 / 8 / 16                                |
|    17 | 17 / 17 / 17 / 34                                | 17 / 17 / 34                              |

One benchmark pacing rAF stream is additional to those terminal scheduling owners. Native terminals share one WASM runtime, but do not share GPU devices/queues. WebGL explicit flush is not equivalent to WebGPU submission; no zero-submission claim is made for xterm.

The analyzer assigns each render span once to its last containing Chrome `AnimationFrame`, then sums independent terminal callback duration in that frame. At count 17, native ASCII median work is 11.47–11.87 ms across repetitions, p95 12.35–13.61 ms, maximum 27.03 ms; SGR median is 11.96–12.10 ms. At count 8, native ASCII medians are 6.44–6.58 ms. xterm count-17 render-callback medians are about 0.61–0.66 ms, but its parsing runs outside these callbacks: this is not a total-CPU comparison. Paced output median intervals remain approximately 16.67 ms, with skipped/stretching frames retained as workload data.

## Input and write timelines

All latency phases have 24 write and 24 input samples per repetition. Input begins at captured keydown, crosses the loopback WebSocket echo, then parses/renders. Write begins at browser write. The analyzer converts captured epoch timestamps through `performance.timeOrigin`, finds the sample's parse/render/command spans, and joins `AnimationFrame::Presentation` to the **containing renderer frame's identity**, never a nearby global GPU event.

### Control latency matrix, milliseconds

| Count | Native write p50 | xterm write p50 | Native input p95 | xterm input p95 |
| ----: | ---------------: | --------------: | ---------------: | --------------: |
|     1 |           17.010 |          12.239 |           28.827 |          39.752 |
|     8 |           20.756 |          16.827 |           25.466 |          27.922 |
|    17 |           20.950 |          16.103 |           26.788 |          31.098 |

One-terminal control write p50 by repetition is native **17.010, 17.952, 10.432**, versus xterm **21.710, 9.864, 12.239**. Input p95 is native **40.082, 23.919, 28.827**, versus xterm **40.369, 39.752, 25.150**. This variance and reversed runs prevent a deterministic claim about the original write gap. The historical native input-p95 disadvantage is absent in this matrix.

### Representative traced samples

Times below are milliseconds after operation start, from repetition 0. A middle write is the upper-middle observed sample in a 24-sample run; the reported run p50 averages the middle pair. A p95 input is the nearest-rank sample. Raw latency traces for both libraries are checked in.

| Event                                | Native middle write, index 15 | xterm middle write, index 11 | Native p95 input, index 25 | xterm p95 input, index 28 |
| ------------------------------------ | ----------------------------: | ---------------------------: | -------------------------: | ------------------------: |
| Echo received                        |                             — |                            — |                      0.700 |                     0.370 |
| Parse start / end                    |                 0.075 / 0.090 |                0.215 / 0.350 |              0.755 / 0.760 |             0.395 / 0.430 |
| Render start / end                   |                 0.245 / 0.465 |                0.510 / 0.740 |            32.070 / 32.490 |           32.315 / 32.390 |
| Final submission/draw call end       |                         0.415 |                        0.740 |                     32.260 |                    32.390 |
| Captured glyph                       |                        10.860 |                        8.496 |                     39.691 |                    40.351 |
| Matched Chrome presentation feedback |                        26.926 |                       23.660 |                     55.831 |                    56.473 |
| Exclusive terminal work              |                         0.320 |                        0.390 |                      0.565 |                     0.115 |

Native input identity is `4ab6eb2b08eca0f1`, xterm input identity `f4483463d242a913`. Native middle-write identity is `4ab6eb2b08ecbe8e`, xterm `f4483463d242b470`. Chrome feedback is about a refresh later than glyph capture here; these are different observables, not an optical presentation claim.

For the native p95 input, `RequestAnimationFrame` occurs at +0.804 ms. The external display callback/BeginFrame arrives at +14.327/+14.384 ms, but `SendDidNotProduceFrame` at +14.387 ms reports numeric reason 1. Pipeline sequence 1144 is `BACKFILL` / `STATE_DROPPED` at +15.167 ms, with `has_main_animation: true`. There is no renderer-main task spanning that refresh; tasks after input finish by +1.717 ms. The next `ProxyMain::BeginMainFrame` arrives at +32.008 ms and the intended terminal render starts at +32.070 ms. Thus the missed boundary is measured, and main-thread parsing/render CPU does not occupy that gap. **The lower-level Chromium skip reason is unconfirmed**; numeric reason 1 is not translated into a causal label. xterm's p95 sample similarly reaches its first renderer boundary at +32.165 ms.

The native middle write renders within 0.5 ms and spends 10.395 ms waiting from render end to captured glyph. Native repetition 2's middle write instead starts rendering at +10.240 ms and captures at +18.807 ms. Scheduling/capture phase varies; sub-millisecond terminal work does not explain a fixed 4.77 ms control gap.

Across all 72 traced one-terminal samples per operation, component medians are:

| Variant / operation |  Echo | Parse end | Render start | Render end | Capture | Chrome feedback | Terminal work |
| ------------------- | ----: | --------: | -----------: | ---------: | ------: | --------------: | ------------: |
| Native write        |     — |     0.105 |        0.757 |      1.270 |  12.114 |          28.137 |         0.388 |
| xterm write         |     — |     0.160 |        0.460 |      0.613 |   9.452 |          27.358 |         0.140 |
| Native input        | 0.588 |     0.615 |       14.885 |     15.373 |  23.036 |          38.967 |         0.488 |
| xterm input         | 0.460 |     0.532 |       15.565 |     15.643 |  23.310 |          39.042 |         0.125 |

These are separate marginal medians, not an additive synthetic sample. Traced latency is perturbed and does not replace control p50/p95. Optical latency, GPU execution duration, the lower-level skipped-frame cause, and a reproducible native-only input scheduling disadvantage remain unconfirmed.

## Evidence and provenance

[Checked-in evidence](benchmarks/mac-m1/attribution-2026-10-01/) contains the corrected rerun in `cpu-corrected-17-ascii/` (compact analysis, both repetition-0 raw Chrome traces, and both screenshots), plus `analysis-1.json`, `analysis-8.json`, `analysis-17.json`, repetition-0 ASCII raw Chrome traces for both libraries at each count, repetition-0 one-terminal latency raw traces, and screenshots at all counts. Compact analyses retain CPU process deltas, whole-main attribution, sampled leaves, all sample timelines, per-terminal counts/ownership, exact frame-counter distributions, qualification metadata, and SHA256 of every full trace and `comparison.json`. Raw qualification intervals are represented by their SHA256 in compact files and retained in full archives.

The measured portable manifest records base commit `d2d01354729989e585ffed681648eedd77b1eb9f` plus dirty tracing-tool changes, source SHA256 `20920b8944e6bcf8f8a02e37cda67d5ace635f5fd3fb7772faa33b04286e228c`, and browser-bundle SHA256 `0aabe0cec8971d67e863c6c8e1ce43357b7f62a2a8981e121603ed2b9fbcd169`. The manifest records versions and fixture hashes. The final postprocessor subsequently added compact output and unique containing-frame assignment; those offline changes did not alter the measured browser bundle. Actual tracing overrides are 180 output writes and 24 samples per latency operation, independent of normal comparison defaults in the manifest.

The corrected portable manifest records clean commit `4b307474e5a6d3919765649a8e5819df9d6d5719`, source SHA256 `99073816515ec1837746f12d8f48db4f16b1ce33394e65662a5bbabc4c6824db`, and browser-bundle SHA256 `2eece08b080a6f89e349609dac823a57f3a1ce348cfb784782dd59a9c7138336`. Its bundle and full run remain on the Mac at `~/tmp/gw-bench/attribution-bundle-v5` and `~/tmp/gw-bench/attribution-mac-17-ascii-v5`.

Full raw archives are outside git at `/work/reports/ghostty-benchmarks/plan-283/`. Their source directories and the measured portable bundle remain on the Mac at `~/tmp/gw-bench/attribution-mac-{1,8,17}-v4` and `~/tmp/gw-bench/attribution-bundle-v4`.

| Archive                              | SHA256                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| `attribution-mac-1-v4.tar.gz`        | `46294c30cc2d0ca7352318b88512375d49b68165956ecd6e5e51bd58d1d46b1e` |
| `attribution-mac-8-v4.tar.gz`        | `bcbd206e32b8ecb297972b51e504a4a7d62abf7bfa451130505cc001b1de4737` |
| `attribution-mac-17-v4.tar.gz`       | `52b57bad8f8e1d46035a1f1547dbd31d193b0cbc764784854ec174ae361bb87e` |
| `attribution-mac-17-ascii-v5.tar.gz` | `a7a5faa48038b7afc2ed28c876f51225a619c3d2521f8c895ca198b371a2f9a7` |

## Reproduction and verification

Tracing is off by default; only benchmark `?trace` installs wrappers. Consumer/library source is unchanged. Recording activates between `traceBegin` and `traceEnd`; UserTiming serialization occurs after the CPU snapshot. Supported flags are `--trace`, `--trace-count 1|8|17`, `--trace-phase latency|ascii|sgr` (default all three), `--trace-frames N` (default 180), `--trace-latency-samples N` (default 48), and `--display-awake`. `--smoke --smoke-instrumentation` checks wrappers without producing hardware performance claims.

From the package directory on Linux, build the established portable bundle:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
nice -n 19 taskset -c 0-7 bun run bench:compare -- \
  --build-only --bundle /work/tmp/plan-283/bundle
```

Ship it using the existing portable runner transfer procedure; its `node_modules` uses the runner's already-installed pinned dependencies at `~/tmp/gw-bench/node_modules`. Use one fresh output directory per count, one `mesh mac -- sh -c '<cmd>'` session, and a bounded window. On the Mac:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
pmset -g batt | command grep 'AC Power' || { echo 'waiting for AC'; exit 1; }
cd ~/tmp/gw-bench/attribution-bundle
caffeinate -d -u -t 1800 node comparison-runner.mjs \
  --trace --trace-count 1 --trace-latency-samples 24 --display-awake \
  --output ../attribution-mac-m1-1
```

Repeat for counts 8 and 17. Reproduce the corrected narrow rerun with `--trace --trace-count 17 --trace-phase ascii --display-awake` in a fresh output directory. Fresh directories are required only for tracing, which owns discard-on-failure. Ordinary comparison reruns reuse their output directory and qualify the idle display at its measured refresh period, including 120/144 Hz. Trace windows on the Mac require idle 60 Hz qualification. Mounted cadence remains workload evidence, but hidden pages, probe errors, and missing/invalid samples reject the window. Expired probes cancel their own rAF callback and cannot append samples or pacing markers to a later probe. Recompute full/compact attribution from any full qualified directory:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
nice -n 19 taskset -c 0-7 node scripts/comparison-attribution.mjs \
  /work/tmp/plan-283/attribution-mac-1-v4 /work/tmp/plan-283/analysis-1.json --compact
nice -n 19 taskset -c 0-7 bun run bench:compare:test
nice -n 19 taskset -c 0-7 bun run typecheck
```

All 44 narrow tooling tests pass. They cover matched CPU acquisition intervals and asynchronous timing uncertainty, run/page failures and incomplete case/phase evidence, numeric option validation and compact CLI parsing, awaited and bounded trace cleanup, stale refresh cancellation, reusable ordinary outputs, portable temporary roots, and display qualification versus workload cadence, diagnostic retention/cleanup, process churn and trace-stream closure, nested-exclusive counters, terminal/frame isolation, ownership identities, clock alignment and main-task union, sampled-profile identity, unique frame aggregation, presentation identity, and compact-evidence preservation. The analyzer rejects failed or unfinished windows before publishing rows, and verifies the selected case matrix, trace/control pairs, sample counts, and display probes. A case deadline awaits context closure and trace finalization; stalled drain has a ten-second give-up and stops the entire window. Package/portable builds, repository pre-commit gates and typechecks, and Linux native/xterm byte/string smoke also passed. The existing `bench:compare:test` entry now includes tracing, attribution, and option regressions through its test imports; pinned package metadata and native-resolver provenance remain unchanged. Seven existing package lint warnings remain outside the changed files. The first repair push passed Ghostty CI jobs; the repository package job failed in unrelated Raspberry Pi tests because CI checks out shallow history (`fregatCheckout` cannot find `3d86637e8`, followed by two lane-lock child-process failures). Product deployment, product fixes, optical measurements, and merge are deliberately outside this Phase 1 delivery.

## Phase 2: packed damaged-row snapshots

### Data boundary and upstream API

The bulk reader moves the per-cell WASM boundary into our existing `bridge.wasm`. One `bridge_read_rows` call iterates requested or damaged rows and writes a reusable packed workspace. A new largest grapheme payload requires one capacity-growth retry; subsequent reads reuse that allocation. JavaScript copies the populated records into owned typed arrays, so returned snapshots survive writes, memory growth, resize, and disposal. Damage acknowledgement remains a separate operation.

The source is official Ghostty at `c8554f28e0efe2f5595f32020371c34b25ec628f`. `GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW` supplies the contiguous borrowed `GhosttyCellsView`. The bridge uses `ghostty_cell_get` for codepoint, content tag, styling presence, and width, plus the official row/cell accessors for resolved colors, styles, graphemes, and row-local selection. It avoids decoding upstream raw-cell bit positions, which are outside the stable ABI contract. Ghostty is unpatched; rebuilding with `bun run build:wasm --source <clean-pinned-checkout>` reproduces the unchanged `ghostty-vt.wasm` and the new bridge.

| Record           |     Size | Fields, in order                                                                            |
| ---------------- | -------: | ------------------------------------------------------------------------------------------- |
| Snapshot header  | 36 bytes | Row pointer/capacity/length; cell pointer/capacity/length; grapheme pointer/capacity/length |
| Row              | 16 bytes | Viewport y, dirty flag, first cell index, cell count                                        |
| Cell             | 24 bytes | Codepoint, foreground RGB, background RGB, flags, grapheme index, grapheme length           |
| Grapheme element |  4 bytes | Unicode codepoint; a cluster contains its base and subsequent codepoints                    |

All fields are little-endian u32 values. RGB is `r | g << 8 | b << 16`; `0xffffffff` means an unset explicit color. Cell flags use bits 0–1 for width, bit 2 for selection, bit 3 for styling presence, bits 4–11 for bold/italic/faint/blink/inverse/invisible/strikethrough/overline, and bits 12 onward for underline style. This layout belongs to our bridge, independent of Ghostty's private raw-cell layout.

WebGPU and WebGL request packed rows. `InstanceRows` reads the records with one reusable scratch cell per row and never materializes a cell array. Public `readRows()` retains owned object snapshots by default; a packed row's `cells` getter materializes lazily for inspection. The initial treatment also invokes that getter for DOM frame data. The targeted follow-up derives frozen text/continuation arrays directly from packed records for caret, links, and accessibility, preserving the existing frame contract. Canvas rendering uses the public object shape and the shared frame helper, with extraction still supplied by the bulk bridge. Wide-cell spans retain the previous continuation scan.

The bridge imports Ghostty's memory and C exports. Its stack is a separately allocated, 16-byte-aligned 64 KiB region, freed with the runtime. The bridge has no memory-initializing data section; a regression test verifies that instantiation leaves existing Ghostty memory intact.

### Correctness

The complete package unit suite passes 354 tests. Five bulk-reader tests include forty seeded random screens compared against the previous per-cell reader on the same native render state. They cover wide text, combining and ZWJ graphemes, palette and truecolor values, every supported style, selection, viewport changes, retained-state dimensions after resize, empty first reads, damaged/requested row filtering, allocation growth, and owned snapshot lifetime. The instance-builder comparison requires equal cell/glyph buffers and throws if the packed path reads the materialized `cells` array. Thirteen built-API Chromium history and pointer-selection tests and twenty-five WebGPU/WebGL renderer browser tests also pass. Two existing Linux SwiftShader device-replacement success/retry cases are skipped. Repository pre-commit gates and typechecks pass.

### Main versus packed snapshots on Apple M1

The initial treatment is measured commit `201ed6ee9298ad3ac06ed79d66f18f62737c15a0`, against main at `24a6f3d04290fb37311fd0fa9c50777ca953d8a0` (PR #245 included). Each condition uses three alternated pairs, AB/BA/AB, with native and paired pinned xterm WebGL controls in every invocation. CPU values below are independently aggregated medians of inactive-wrapper controls, in percent of one core. Traces use 180 paced writes plus one clear render. No CPU-rate improvement is inferred from a smaller snapshot share.

| Count / output | Native renderer before → after | Native total before → after | xterm renderer before → after | xterm total before → after |
| -------------- | -----------------------------: | --------------------------: | ----------------------------: | -------------------------: |
| 1 / ASCII      |                  23.73 → 23.00 |               36.44 → 37.41 |                 20.92 → 19.56 |              36.50 → 34.93 |
| 1 / SGR        |                  24.91 → 23.10 |               37.63 → 37.52 |                 19.89 → 20.90 |              36.27 → 35.74 |
| 17 / ASCII     |                107.84 → 113.42 |             155.89 → 179.98 |                 79.53 → 83.30 |            142.44 → 160.30 |
| 17 / SGR       |                 104.62 → 96.14 |             154.29 → 146.52 |                 93.02 → 87.10 |            168.65 → 161.13 |

**Losses:** 17-terminal ASCII renderer CPU rises 5.58 percentage points and total CPU rises 24.09 points; all three paired native rate deltas lose. One-terminal ASCII total CPU rises 0.97 points. The 17-terminal SGR medians improve, but repetition 0 loses: renderer +8.53 points and total +24.84 points. xterm controls also vary, particularly at 17 terminals, so three pairs establish an observed result rather than a confidence interval or isolated causal effect. Native after-treatment renderer CPU remains higher than its paired xterm median in all four conditions.

The paced 180-write workloads have different elapsed times when frames stretch. CPU rate measures utilization per wall-clock second; CPU seconds measure consumption for the fixed work. They answer different questions. Values below are separate medians, not an additive synthetic run.

| Count / output | Native elapsed ms before → after | Native renderer CPU seconds before → after | Native total CPU seconds before → after | xterm after renderer / total CPU seconds | Native GPU-process CPU before → after |
| -------------- | -------------------------------: | -----------------------------------------: | --------------------------------------: | ---------------------------------------: | ------------------------------------: |
| 1 / ASCII      |                3079.87 → 3078.68 |                              0.731 → 0.708 |                           1.123 → 1.151 |                            0.602 / 1.076 |                         12.45 → 13.71 |
| 1 / SGR        |                3073.29 → 3077.66 |                              0.762 → 0.712 |                           1.153 → 1.156 |                            0.643 / 1.101 |                         12.65 → 13.95 |
| 17 / ASCII     |                4191.14 → 3590.36 |                              4.520 → 4.209 |                           6.633 → 6.476 |                            2.706 / 4.979 |                         48.17 → 62.90 |
| 17 / SGR       |                3877.41 → 3086.28 |                              3.970 → 2.959 |                           5.854 → 4.509 |                            2.680 / 4.958 |                         47.65 → 54.74 |

GPU-process CPU is process CPU consumption, not GPU execution time. The lower fixed-work CPU seconds at 17-terminal ASCII coexist with higher CPU rates and a shorter output interval. This does not satisfy an unqualified claim that the CPU-rate disadvantage is fixed.

### Whole-main attribution and migrated work

The sums below cover all three traced runs. Shares use whole renderer-main task time, including uninstrumented residual. Trace perturbation prevents extrapolating these percentages into control CPU savings.

| Count / output | Snapshot share before → after | Snapshot ms before → after | Instances ms before → after | JS ms before → after | Snapshot + instances + JS ms before → after | Whole-main ms before → after |
| -------------- | ----------------------------: | -------------------------: | --------------------------: | -------------------: | ------------------------------------------: | ---------------------------: |
| 1 / ASCII      |                22.44% → 6.59% |             170.73 → 43.48 |             141.17 → 141.10 |      135.26 → 149.38 |                             447.16 → 333.96 |              760.90 → 659.31 |
| 1 / SGR        |                26.11% → 7.34% |             223.21 → 52.86 |              99.14 → 110.06 |      147.53 → 167.00 |                             469.87 → 329.92 |              854.75 → 720.23 |
| 17 / ASCII     |                39.21% → 5.51% |           5680.76 → 670.31 |           4656.72 → 5916.82 |    1932.16 → 2892.23 |                          12269.64 → 9479.36 |          14486.55 → 12156.12 |
| 17 / SGR       |                47.22% → 7.06% |           6997.83 → 722.16 |           2988.71 → 3603.48 |    1893.92 → 2601.25 |                          11880.47 → 6926.90 |          14819.77 → 10229.93 |

Snapshot extraction shrinks, while packed text/style decoding moves into instances and DOM frame consumers materialize cells under JS. Both stages rise at 17 terminals. Their combined absolute time falls 22.74% for ASCII and 41.70% for SGR; whole-main task time falls 16.09% and 30.97%. Those trace reductions are real within the recorded boundaries, but they are not evidence of a universal process CPU-rate win.

The targeted 17-ASCII sample-stack inspection measures inclusive `copiedFrameRow` work at 71.58 / 92.53 / 79.69 ms before and 257.72 / 312.00 / 311.48 ms after. The summed increase is 637.41 ms, with after materialization/getter descendants accounting for about 512.33 ms. Total after frame-copy work is 7.25% of whole-main task time. GC leaf samples rise 162.29 → 408.09 ms, but these CPU traces measure neither allocation bytes nor which prior allocator caused a collection. This identifies a concrete avoidable cost to test; it does not prove that removing it fixes the process CPU regression.

### Qualification, parity, and provenance

The owner’s Apple M1 MacBook Air uses headed Chromium 153.0.8010.12, Darwin 25.4.0 arm64, and ANGLE Metal. WebGPU is hardware-enabled with a non-fallback adapter. Every one of 24 invocations records an AC-power check, each condition holds the display with `caffeinate -d -u -t 1800`, and exclusivity is checked before its window. Windows take 9.97 minutes (17 ASCII), 9.34 (17 SGR), 4.67 (1 ASCII), and 4.50 (1 SGR), each below 30 minutes. All 48 idle-display probes qualify; process CPU acquisition intervals qualify. The PR #245 on-screen transform, backing dimensions, fonts, grid, fixtures, and browser are matched. Mounted cadence remains workload evidence.

All native counters and ownership totals match: 181 terminal renders, 2172 rows and 86880 cells per terminal per trace; each render copies 12 rows / 480 cells, writes two buffers totaling 76800 bytes, draws twice, submits once, and uploads no warm atlas data. One saved baseline 17-ASCII repetition-2 frame summary mislabels its first two rows, despite correct raw spans and terminal-tagged counters. The validator reconstructs the exact per-frame distributions from those raw records, verifies 181 matching frames per terminal, and retains the saved-summary discrepancy in `matched-work-checks.json`. Its cause in the persisted summary is unconfirmed; raw records are authoritative for this check.

The established runner captures the shared correctness fixture before output only in repetition 0. Native PNG bytes match main for both counts in both condition windows, and all eight before/after PNGs were read back: ASCII, foreground colors, wide text, combining text, emoji and overwrite output are visible, with all 17 terminals placed on-screen. These are correctness-fixture screenshots, not distinct ASCII/SGR endpoint captures. Repetitions 1 and 2 retain matching correctness records but no PNGs; no all-repetition screenshot claim is made.

[Compact evidence and reproduction inputs](benchmarks/mac-m1/packed-snapshot-2026-10-01/) include eight analyses, per-run CPU values and timings, raw-window hashes, before/after manifests, matched-work checks, stack sampling, and screenshots. The 336 MiB full archive remains at `/work/tmp/plan-283-fix2/corrected/raw-evidence.tar.gz` and the Mac’s `~/tmp/gw-bench/p283-bulk-snapshot/corrected/raw-evidence.tar.gz`, SHA256 `dd0cd5413ba27110590a210a443b36372689e0d16db476a3c84663866980d350`. Faulty damage-scratch runs and every overlapping duplicate-session matrix are excluded.

The frozen treatment source SHA256 is `0e8b7fb53e29b68a403e589e46146e2376469ef06ecdd97a060f67be1fd8f933`; its browser bundle is `511fca66a42d2d8b8da47dec9ae30057a096170c6cc8cc6cf40c42dce01f36ae`. Baseline carries the equivalent tracing-counter change only. Control assets and portable runners are byte-identical; only the native browser source/bundle and `bridge.wasm` change. The pinned upstream `ghostty-vt.wasm` SHA256 remains `dfb171587bc11b6610fb95d3b583926d51287f5d6e528c45ff2aa05218608a97`; bridge SHA256 is `e2e1fb9a1b6d36f6b8ee4aa7e615e5bc6aeefda69f494832317b46fdea84241a`.

To reproduce offline, extract the full archive into a fresh evidence root, set `root` in the supplied Python inputs to that path, run `combine.py`, run the checked-in `scripts/comparison-attribution.mjs <condition-directory> <condition-directory>/analysis.json --compact` for all eight combinations, then run `summarize.py`, `validate-matched.py`, and `profile-frame.py`. `method.json`, the paired runner and window script preserve the hardware protocol. Use the heavy scheduler for browser/build/trace work.

### Targeted follow-up: direct-packed DOM frame text

The only follow-up changes `copiedFrameRow` to read text and continuation flags directly from packed cells, retaining its frozen row/cell/continuation arrays for caret, link and accessibility consumers. Three real-terminal differential cases compare the former materialized mapping against the direct path and object fallback, reject access to the lazy `cells` getter, and verify retained frame data after memory growth, resize, writes and disposal. The complete suite now passes 357 unit tests and 66 Chromium browser tests covering terminal UI, history, pointer selection, WebGPU and WebGL; the same two SwiftShader device-replacement cases remain skipped. Package build/typecheck and repository commit gates pass.

Measured candidate `04b2d2437e8366b3c703c457f8dd07c19b9e979d` is compared with the same frozen main bundle at `24a6f3d04` in a **fresh** two-condition AB/BA/AB matrix. The following values belong exclusively to that rerun; the initial matrix above is retained in full.

| 17-terminal output | Native renderer before → after | Native total before → after | xterm renderer before → after | xterm total before → after |
| ------------------ | -----------------------------: | --------------------------: | ----------------------------: | -------------------------: |
| ASCII              |                  70.75 → 50.11 |              100.84 → 81.68 |                 53.85 → 51.95 |              94.28 → 91.83 |
| SGR                |                  72.59 → 46.89 |               99.67 → 80.15 |                 54.41 → 54.16 |              91.97 → 93.88 |

Native renderer/total rate deltas are negative in all three pairs: ASCII renderer −21.54 / −18.50 / −20.15 percentage points, total −17.53 / −14.79 / −19.78; SGR renderer −25.70 / −23.64 / −25.57, total −19.96 / −15.44 / −19.52. These are materially larger than the changes in paired xterm controls. Native after-treatment renderer medians are below xterm in both conditions, but ASCII repetition 2 remains above its paired xterm renderer, 50.59% versus 48.71%. xterm total CPU rises in ASCII repetitions 1/2 and SGR repetition 2. Three pairs remain observations rather than confidence intervals or a general parity claim.

| 17-terminal output | Native elapsed ms before → after | Native renderer CPU seconds before → after | Native total CPU seconds before → after | xterm after renderer / total CPU seconds | Native GPU-process CPU before → after |
| ------------------ | -------------------------------: | -----------------------------------------: | --------------------------------------: | ---------------------------------------: | ------------------------------------: |
| ASCII              |                3097.93 → 3070.30 |                              2.201 → 1.541 |                           3.130 → 2.511 |                            1.598 / 2.823 |                         29.95 → 31.18 |
| SGR                |                3074.35 → 3074.20 |                              2.233 → 1.442 |                           3.065 → 2.465 |                            1.665 / 2.886 |                         27.08 → 32.93 |

**Remaining losses:** native GPU-process CPU rises in both conditions. SGR instance work rises 73.64 ms across the three traces. Total process CPU nevertheless falls in every native pair. CPU rates, CPU seconds and elapsed work stay separate observables; GPU-process CPU remains a CPU measure, with no GPU execution-time claim.

| 17-terminal output | Snapshot share before → after | Snapshot ms before → after | Instances ms before → after | JS ms before → after | Snapshot + instances + JS ms before → after | Whole-main ms before → after |
| ------------------ | ----------------------------: | -------------------------: | --------------------------: | -------------------: | ------------------------------------------: | ---------------------------: |
| ASCII              |                39.52% → 6.10% |           2318.40 → 226.63 |           1905.83 → 1903.75 |      717.35 → 610.88 |                           4941.59 → 2741.26 |            5865.90 → 3714.14 |
| SGR                |                47.81% → 8.34% |           2917.76 → 281.19 |           1224.68 → 1298.33 |      687.50 → 593.76 |                           4829.94 → 2173.27 |            6102.48 → 3372.95 |

These are absolute sums across three traced runs. Snapshot extraction shrinks; instance decoding remains, with SGR migration into that stage. Combined snapshot/instances/JS and whole-main time fall in both conditions. The control CPU measurements establish the observed utilization improvement; snapshot share alone does not establish it.

Fresh ASCII sample stacks expose `copiedFrameRow` inclusive totals of 13.67 ms for main and 2.15 ms for the candidate, with no named materialization/getter descendants in the candidate. GC leaf samples are 98.85 → 108.00 ms. Sampling and inlining limit named-function attribution; these traces measure neither allocation bytes nor causally attributable GC. The getter-rejection differential tests establish the eliminated materialization path independently of samples.

**Cross-matrix limitation:** the byte-identical main bundle's ASCII renderer CPU shifts 107.84% in the initial matrix to 70.75% in the fresh matrix; xterm shifts 79.53% to 53.85%. Main's trace frame-copy samples also shrink substantially. Recorded browser/OS/hardware, launch flags, baseline source/bundle hashes, versions, settings, fixtures and assets match; the cause of this broader performance shift is unconfirmed. Clock/thermal state is unavailable. The fresh matrix compares the complete packed-plus-frame treatment with main, and does not isolate the incremental frame change from the first packed implementation under identical conditions. Consequently, 113.42% → 50.11% across the two treatment matrices is **not** attributed to the frame-copy change. The fresh paired improvement meets the observed 17-ASCII CPU bar in this window; its reproducibility across operating conditions remains open for review.

Both exclusive windows record AC before/after all twelve invocations, hardware Metal with a non-fallback WebGPU adapter, unchanged idle-display qualification, and `caffeinate -d -u -t 1800`. ASCII takes 6.31 minutes and SGR 6.26 minutes. All 24 idle probes and CPU acquisition intervals qualify. Counters, raw per-frame distributions, grid, ownership and correctness records match; this rerun has no persisted-frame-summary discrepancy. The four captured native repetition-0 correctness-fixture PNGs are byte-identical to main and were read back, showing the same colored/wide/combining/emoji/overwrite fixture with all 17 terminals on-screen. These are fixture screenshots, with the same capture limitations as the initial matrix.

[Follow-up evidence and reproduction inputs](benchmarks/mac-m1/packed-snapshot-2026-10-01/frame-optimized/) retain four compact analyses, every pair, manifests, power/window records, parity checks, sampled stacks, cross-matrix checks and PNGs. The 227 MiB raw archive remains at `/work/tmp/plan-283-fix2/frame-optimized/raw-evidence.tar.gz` and the Mac's `~/tmp/gw-bench/p283-bulk-snapshot/frame-optimized/raw-evidence.tar.gz`; verified transfer SHA256 is `049eb6f2ea03d47310cfc276dca180c1e4a303b83dd4fc7d38e054ff48ca9f0b`. Candidate source SHA256 is `7dffdb328db33f62da70a4d22dc0da22aa0a2aaf9af0fdbdbdbc46795a802dc7`, browser bundle `26e60e4a8f78c8f048e4aa5ec112dcd88324426130116e28a56ba18234dc97de`; both WASM hashes remain unchanged from the initial packed treatment. Reproduction uses the same supplied offline pipeline with these four combinations.

After measurement, current main is merged normally into the task branch to settle CI gate-list integration drift; main's files are retained and the frozen measured implementation is identified separately from the resulting PR head. No further optimization or hardware condition is added. The PR remains draft for review. One-terminal targets are not rerun after the frame change; input echo, idle workload, parse-only and memory targets are not remeasured. Production deployment and PR merge are outside this delivery.
