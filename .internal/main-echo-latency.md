# Main-thread echo latency

## Diagnosis

The main entry's ~28.5 ms p50 is not high for the C5 endpoint. xterm.js WebGL has the same delay in the same harness. The endpoint records when Chrome delivers `AnimationFrame::Presentation` feedback to the renderer main thread, not when the display presents the echo.

The scheduler is not adding a frame. Parsing finishes in under 1 ms at the median, the animation-frame draw starts about 1.5 ms after input, and the render boundary ends about 2 ms after input. No production scheduling change is justified by these traces.

The current C5 main-versus-worker comparison is not a presentation comparison. The worker join can select feedback for a page animation frame that does not contain the worker's OffscreenCanvas frame. The adaptive-presentation experiment needs a causal worker endpoint before it can support a keep-or-reject decision.

## Trace evidence

The follow-up run used an M1 MacBook Air on AC power, headed Chromium 153.0.8010.12, DPR 2, and hardware Metal adapters. Production source was `0ed4b5873b1e0938118a1724e4f971195e72fb29`. Each arm measured 12 real key echoes. All 36 echoes passed the strict containing-animation-frame join and the compositor trace-ID join.

These are per-echo p50 values in milliseconds from keydown. `Render end` is the backend's instrumented submission or final draw call. `Display vsync` is the first vsync after the echo's joined buffer swap.

| Arm                 | Parse end | Draw start | Render end | Swap end | Display vsync | Chrome feedback | Feedback after vsync |
| ------------------- | --------: | ---------: | ---------: | -------: | ------------: | --------------: | -------------------: |
| Ghostty WebGPU main |      0.60 |       1.45 |       2.10 |     4.69 |          6.68 |           30.54 |                23.91 |
| Ghostty WebGL2 main |      0.85 |       1.55 |       1.95 |     5.25 |          6.33 |           30.37 |                23.93 |
| xterm.js WebGL main |      0.40 |       1.15 |       1.50 |     3.59 |          7.48 |           30.71 |                23.94 |

About 24 ms of the new ~30 ms reading arrives after the display vsync. Chrome delivers the feedback on a later animation-frame turn. That delivery delay is not extra key-to-display time. Some buffer swaps miss the immediate vsync, so the first following display vsync falls one refresh later. Those cases account for the display-vsync p95 values of 23 to 24 ms.

The original 80-sample main traces tell the same renderer-side story. Strict causal joins put the WebGPU submission p50 at 1.90 ms and the feedback p50 at 28.43 ms. The remaining 26.38 ms sits after submission, not in input handling, parsing, or RAF scheduling.

## Next measurement

Use the compositor surface trace IDs and following display vsync for both main and OffscreenCanvas frames, or use the comparison runner's screencast pixel marker. Then rerun the adaptive-presentation comparison. `diagnose-main.mjs` implements the main-thread join and leaves worker arms out deliberately.

Raw traces, screenshots, the measurement log, and `main-analysis.json` are in `/work/reports/ghostty-webgpu-next-2026-10/c5-idle-immediate/main-echo-diagnosis/`. Regenerate the summary with:

```sh
node .internal/c5-idle-immediate/diagnose-main.mjs /work/reports/ghostty-webgpu-next-2026-10/c5-idle-immediate/main-echo-diagnosis
```

These 12-sample comparisons are exploratory. The stricter comparison runner refused to measure because T3 Code was running on the Mac. The C5 hardware checks passed, and the Mac lock, AC check, DPR check, visibility check, and adapter checks all passed, but the T3 presence keeps these numbers out of the qualified benchmark set.
