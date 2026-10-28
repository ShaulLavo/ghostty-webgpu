# Main-thread echo latency

## What the traces prove

The main entry's ~28.5 ms p50 measures keydown to Chrome's reported presentation timestamp. `AnimationFrame::Presentation` takes that timestamp from `presentation_feedback.timestamp`. It can be a platform estimate. The event does not measure callback-delivery time or prove physical scanout time.

The renderer-side stages are much shorter. Parsing finishes in under 1 ms at the median, the animation-frame draw starts about 1.5 ms after input, and the instrumented render boundary ends about 2 ms after input. That boundary is a submission or final draw call, not GPU completion. The traces do not explain the remaining interval, and they do not prove or rule out an extra compositor frame.

The exploratory xterm.js arm has similar reported presentation timestamps. This does not show Ghostty-specific overhead before the render boundary. Physical key-to-display latency remains unresolved.

The worker join can select feedback for a page animation frame that does not contain the worker's OffscreenCanvas frame. Worker presentation timing therefore remains unresolved. The main-entry adaptive comparison remains valid because both arms use the containing main animation frame and the same reported-presentation endpoint.

## Trace evidence

The follow-up run used an M1 MacBook Air on AC power, headed Chromium 153.0.8010.12, DPR 2, and hardware Metal adapters. Production source was `0ed4b5873b1e0938118a1724e4f971195e72fb29`. Each arm measured 12 real key echoes. All 36 echoes passed the strict containing-animation-frame join. No compositor-ID join is claimed.

These are per-echo p50 values in milliseconds from keydown. `After render` is the interval to Chrome's reported presentation timestamp.

| Arm                 | Parse end | Draw start | Render end | Chrome reported presentation | After render |
| ------------------- | --------: | ---------: | ---------: | ---------------------------: | -----------: |
| Ghostty WebGPU main |      0.60 |       1.45 |       2.10 |                        30.54 |        28.67 |
| Ghostty WebGL2 main |      0.85 |       1.55 |       1.95 |                        30.37 |        28.25 |
| xterm.js WebGL main |      0.40 |       1.15 |       1.50 |                        30.71 |        28.89 |

Pooling both original WebGPU baseline repetitions gives 80 captures. Their strict-join render-boundary p50 is 2.10 ms, their reported-presentation p50 is 28.50 ms, and the after-render p50 is 26.27 ms.

`diagnose-main.mjs` implements only the containing-animation-frame join. It does not compare 64-bit compositor IDs or interpret `OnVSyncPresentation` callbacks as frame-specific display timestamps. A future physical-presentation endpoint needs causal frame attribution and qualification.

Raw traces, screenshots, the measurement log, and `main-analysis.json` are in `/work/reports/ghostty-webgpu-next-2026-10/c5-idle-immediate/main-echo-diagnosis/`. Regenerate the summary with:

```sh
node .internal/c5-idle-immediate/diagnose-main.mjs /work/reports/ghostty-webgpu-next-2026-10/c5-idle-immediate/main-echo-diagnosis
```

These 12-sample comparisons are exploratory. The stricter comparison runner refused to measure because T3 Code was running on the Mac. The C5 hardware checks passed, and the Mac lock, AC check, DPR check, visibility check, and adapter checks all passed, but the T3 presence keeps these numbers out of the qualified benchmark set.
