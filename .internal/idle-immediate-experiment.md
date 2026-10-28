# Adaptive idle-immediate presentation experiment

Status: REJECT. Date: 2026-10-28. Plan item: C5.

The adaptive scheduler does not meet the latency gate in either qualified main-entry condition. Worker presentation latency is unresolved because the trace join does not prove which compositor frame contains the worker's output. The production scheduler stays unchanged. The measured implementation is retained in [prototype.patch](c5-idle-immediate/prototype.patch).

## Decision

The gate requires at least 20% improvement in both p50 and p95 input-to-presented latency, no sustained-output CPU regression, and identical output. Both main-entry cells miss the latency gate without using any worker latency numbers. WebGL2 worker CPU also regresses.

| Entry and backend | Baseline p50 | Adaptive p50 | p50 change | Baseline p95 | Adaptive p95 | p95 change |
| ----------------- | -----------: | -----------: | ---------: | -----------: | -----------: | ---------: |
| Main WebGPU       |    28.500 ms |    28.712 ms |      -0.7% |    30.092 ms |    29.994 ms |      +0.3% |
| Main WebGL2       |    28.746 ms |    28.789 ms |      -0.1% |    30.448 ms |    31.000 ms |      -1.8% |

Positive changes are improvements. Each cell aggregates 80 real key events across two repetitions. The measurements do not establish why immediate drawing failed to improve main-entry latency. Claims about RAF phase or delivery landing in the same presentation window remain hypotheses.

## Worker presentation is unresolved

The worker join selects a preceding or following main-thread animation frame by time. Matching that frame's `args.id` to `AnimationFrame::Presentation` feedback does not prove that the frame contains the OffscreenCanvas output. A65 explicitly rejects this nearby-frame fallback.

The raw traces show the missing identity link. All 320 selected worker feedback events have `begin_frame_id: {source_id: 0, sequence_number: 0}`, compared with zero such events among the 320 main-entry selections. In `webgpu-worker-baseline-r0`, capture index 1 selects feedback at 4.006 ms, but subsequent WebGPU processing starts at about 4.118 ms and `Display::DrawAndSwap` starts at 5.325 ms. The selected feedback cannot establish presentation of that echo.

Worker p50 and p95 values are therefore diagnostic, unqualified numbers. They do not prove presented echoes, a worker presentation regression, or compositor-frame misses. A valid worker measurement needs a causal OffscreenCanvas provider or frame identity and qualification with A65's actual-paint delay control. No new hardware run was needed to reject the main-entry treatment.

## The main-versus-worker baseline gap is unexplained

The recorded baseline endpoints differ by about 5x. WebGPU reports 28.500 ms main versus 5.679 ms worker, and WebGL2 reports 28.746 ms main versus 4.911 ms worker. The worker endpoints are unqualified, so this is a finding about the recorded diagnostic gap rather than a proven presented-latency difference.

Both baseline repetitions give these median stage timings.

| Stage                            | Main WebGPU | Worker WebGPU | Main WebGL2 | Worker WebGL2 |
| -------------------------------- | ----------: | ------------: | ----------: | ------------: |
| Key to parse end                 |    0.800 ms |      2.850 ms |    0.700 ms |      3.050 ms |
| Key to command end               |    2.100 ms |      3.700 ms |    1.900 ms |      3.800 ms |
| Command end to selected feedback |   26.271 ms |      2.432 ms |   26.733 ms |      2.105 ms |

The numerical gap appears after command submission, exactly where the worker endpoint lacks a causal join. An extra main-thread display frame, a particular input-versus-RAF phase, and compositor scheduling differences are unproven explanations. A desynchronized-worker-canvas explanation is also unsupported. The renderer requests desynchronization only for `presentation === 'immediate'`, while these arms use frame or adaptive presentation.

## Protocol

The control is `58a090d5697b9e261e192386db88d83da8466374`. The measured candidate is `47368340baac1b4fa0af028e2758a2f519246cfe`, whose production changes are identical to `73775b6d43f0b871c6421e14b84929f9515c4660`. The later commit changes only the trace join and analyzer.

The M1 MacBook Air ran on AC power with the fail-closed agent lock. Chromium 153.0.8010.12 used Apple Metal 3 for WebGPU and ANGLE Metal on Apple M1 for WebGL2. Every arm used one 80x24 terminal at DPR 2 in a fresh headed browser. No software adapter or headless result qualifies this decision.

Each arm typed 40 `#` keys into an idle terminal. The input callback echoed each key locally, without a network or shell. Two animation frames and timed pauses separated the reset and next key. Additional 40 to 139 ms pauses varied the typing cadence. Conditions ran in this order, with source order counterbalanced by condition and repetition:

1. WebGPU main, WebGPU worker, WebGL2 worker, WebGL2 main.
2. Baseline then adaptive on even slots, adaptive then baseline on odd slots.
3. The reversed source order on the second repetition.

The qualified main-entry endpoint follows A65. A keydown timestamp joins to the echo's native parse span, renderer command boundary, command-buffer identity where WebGPU uses one, the containing Chrome animation-frame identity, and that frame's `AnimationFrame::Presentation` feedback. Every selected presentation occurs after the terminal command finishes. Screenshot time is never a latency endpoint.

All 320 matched baseline/adaptive echo screenshot pairs have identical SHA-256 hashes. These screenshots prove equal content, not presentation timing. Across each source and main-entry backend, the latency windows parse 160 writes, record 158 submissions, and join 80 presented echoes. Worker windows have the same parse and submission counts, but their 80 selected feedback events are not qualified presented-echo counts.

## Sustained output and CPU

Each arm wrote 600 identical 16,002-byte payloads at a 4 ms cadence, for 9,601,200 input bytes. All final text hashes match. The CPU endpoint is all-Chrome process CPU from `SystemInfo.getProcessInfo`, expressed as a percentage of one core. These CPU windows were not presentation-traced, so they do not supply presented-frame counts. The worker presentation join problem does not invalidate these independent CPU and output records.

| Entry and backend | Median adaptive/control CPU |  Pair ratios | Control GPU submissions | Adaptive GPU submissions |
| ----------------- | --------------------------: | -----------: | ----------------------: | -----------------------: |
| Main WebGPU       |                       0.969 | 0.985, 0.953 |                506, 505 |                 496, 479 |
| Worker WebGPU     |                       1.006 | 1.008, 1.004 |                464, 470 |                 468, 466 |
| Worker WebGL2     |                       1.038 | 1.035, 1.041 |                    2, 2 |                     2, 2 |
| Main WebGL2       |                       0.946 | 0.898, 0.994 |                    2, 2 |                     2, 2 |

The table records actual GPU submissions separately from parsed writes. WebGPU submission counts vary with completed scheduling windows and do not pass an identical-count check. WebGL2 skips no-change draws in this repeated-output workload. Host frame notices also vary and remain separate from GPU submissions. The experiment already fails its main-entry latency gate, so these differences do not change the decision.

## Evidence and reproduction

Raw traces, screenshots, process CPU records and the full report are in `/work/reports/ghostty-webgpu-next-2026-10/c5-idle-immediate/mac-full/`. The directory is 68 MB. `c5-results.json` contains the arm records. `analysis.json` preserves the original calculations, including the unqualified worker values; it does not upgrade them into presentation evidence. The short all-condition qualification is in `mac-qualification/`, and its worker latency values have the same limitation. Its two-sample latencies are not decision evidence.

The rerunnable tools are [measure.mjs](c5-idle-immediate/measure.mjs), [presentation.mjs](c5-idle-immediate/presentation.mjs), and [analyze.mjs](c5-idle-immediate/analyze.mjs). The current presentation script supports the main-entry analysis and emits only unqualified worker diagnostics. Apply `prototype.patch` to a candidate copy of the control, stage that copy and an unpatched control with dependencies, then run on the locked M1 Mac:

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

Main-entry measurements use Chrome's presentation feedback, not physical scanout. The experiment covers local echo on the M1 only, as C5 requires. It does not claim live application producer latency or cross-host behavior.
