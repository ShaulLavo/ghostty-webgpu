# Adaptive idle-immediate presentation experiment

Status: REJECT. Date: 2026-10-28. Plan item: C5.

The adaptive scheduler does not meet the latency gate. It leaves main-entry latency unchanged and makes worker tails worse. The production scheduler stays unchanged. The measured implementation is retained in [prototype.patch](c5-idle-immediate/prototype.patch).

## Decision

The gate requires at least 20% improvement in both p50 and p95 input-to-presented latency, no sustained-output CPU regression, and identical output. Only two worker p50 results improve at all, and neither reaches the complete gate. WebGL2 worker CPU also regresses.

| Entry and backend | Baseline p50 | Adaptive p50 | p50 change | Baseline p95 | Adaptive p95 | p95 change |
| ----------------- | -----------: | -----------: | ---------: | -----------: | -----------: | ---------: |
| Main WebGPU       |    28.500 ms |    28.712 ms |      -0.7% |    30.092 ms |    29.994 ms |      +0.3% |
| Worker WebGPU     |     5.679 ms |     4.380 ms |     +22.9% |     8.164 ms |    22.377 ms |    -174.1% |
| Worker WebGL2     |     4.911 ms |     4.349 ms |     +11.4% |     8.192 ms |     8.884 ms |      -8.4% |
| Main WebGL2       |    28.746 ms |    28.789 ms |      -0.1% |    30.448 ms |    31.000 ms |      -1.8% |

Positive changes are improvements. Each cell aggregates 80 real key events across two repetitions. The WebGPU worker tail is systematic. Its two adaptive repetitions have p95 values of 23.319 ms and 23.136 ms, with three samples above 20 ms in each. Immediate off-phase submissions help the median but miss the following compositor frame often enough to lose the tail gate. Main-entry RAF delivery already lands in the same presentation window as adaptive delivery, so immediate drawing provides no measurable benefit there.

## Protocol

The control is `58a090d5697b9e261e192386db88d83da8466374`. The measured candidate is `47368340baac1b4fa0af028e2758a2f519246cfe`, whose production changes are identical to `73775b6d43f0b871c6421e14b84929f9515c4660`. The later commit changes only the trace join and analyzer.

The M1 MacBook Air ran on AC power with the fail-closed agent lock. Chromium 153.0.8010.12 used Apple Metal 3 for WebGPU and ANGLE Metal on Apple M1 for WebGL2. Every arm used one 80x24 terminal at DPR 2 in a fresh headed browser. No software adapter or headless result qualifies this decision.

Each arm typed 40 `#` keys into an idle terminal. The input callback echoed each key locally, without a network or shell. Two animation frames and timed pauses separated the reset and next key. Additional 40 to 139 ms pauses varied the typing cadence. Conditions ran in this order, with source order counterbalanced by condition and repetition:

1. WebGPU main, WebGPU worker, WebGL2 worker, WebGL2 main.
2. Baseline then adaptive on even slots, adaptive then baseline on odd slots.
3. The reversed source order on the second repetition.

The latency endpoint follows A65. A keydown timestamp joins to the echo's native parse span, renderer command boundary, command-buffer identity where WebGPU uses one, containing or adjacent Chrome animation-frame identity, and that frame's `AnimationFrame::Presentation` feedback. Worker records use the worker clock origin and the renderer main thread's animation frames. A submission selects the preceding frame only when that frame's presentation follows the command boundary. Otherwise it selects the following frame. Every selected presentation must occur after the terminal command finishes. Screenshot time is never a latency endpoint.

All 320 matched baseline/adaptive echo screenshot pairs have identical SHA-256 hashes. Across each source and condition, the latency windows parse 160 writes, record 158 submissions, and join 80 presented echoes. These counts are separate endpoints.

## Sustained output and CPU

Each arm wrote 600 identical 16,002-byte payloads at a 4 ms cadence, for 9,601,200 input bytes. All final text hashes match. The CPU endpoint is all-Chrome process CPU from `SystemInfo.getProcessInfo`, expressed as a percentage of one core. These CPU windows were not presentation-traced, so they do not supply presented-frame counts.

| Entry and backend | Median adaptive/control CPU |  Pair ratios | Control GPU submissions | Adaptive GPU submissions |
| ----------------- | --------------------------: | -----------: | ----------------------: | -----------------------: |
| Main WebGPU       |                       0.969 | 0.985, 0.953 |                506, 505 |                 496, 479 |
| Worker WebGPU     |                       1.006 | 1.008, 1.004 |                464, 470 |                 468, 466 |
| Worker WebGL2     |                       1.038 | 1.035, 1.041 |                    2, 2 |                     2, 2 |
| Main WebGL2       |                       0.946 | 0.898, 0.994 |                    2, 2 |                     2, 2 |

The table records actual GPU submissions separately from parsed writes. WebGPU submission counts vary with completed scheduling windows and do not pass an identical-count check. WebGL2 skips no-change draws in this repeated-output workload. Host frame notices also vary and remain separate from GPU submissions. The experiment already fails its latency gate, so these differences do not change the decision.

## Evidence and reproduction

Raw traces, screenshots, process CPU records and the full report are in `/work/reports/ghostty-webgpu-next-2026-10/c5-idle-immediate/mac-full/`. The directory is 68 MB. `c5-results.json` contains the arm records and `analysis.json` contains the gate calculation. The short all-condition qualification is in `mac-qualification/`; its two-sample latencies are not decision evidence.

The rerunnable tools are [measure.mjs](c5-idle-immediate/measure.mjs), [presentation.mjs](c5-idle-immediate/presentation.mjs), and [analyze.mjs](c5-idle-immediate/analyze.mjs). Apply `prototype.patch` to a candidate copy of the control, stage that copy and an unpatched control with dependencies, then run on the locked M1 Mac:

```sh
C5_BASELINE=/path/to/control \
C5_CANDIDATE=/path/to/adaptive \
C5_BASELINE_SHA=58a090d5697b9e261e192386db88d83da8466374 \
C5_CANDIDATE_SHA=47368340baac1b4fa0af028e2758a2f519246cfe \
C5_OUTPUT=/path/to/results \
C5_SAMPLES=40 C5_REPETITIONS=2 C5_SUSTAINED_WRITES=600 C5_PORT=41882 \
bun .internal/c5-idle-immediate/measure.mjs
bun .internal/c5-idle-immediate/analyze.mjs /path/to/results
```

This measures Chrome's presentation feedback, not physical scanout. It covers local echo on the M1 only, as C5 requires. It does not claim live application producer latency or cross-host behavior.
