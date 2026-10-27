# Observer text from retained frames

Status: Approved; cumulative normal-path gate passed on both hosts.

Without a styled `onFrame` consumer, a retained subscriber supplies its text observers from its
own pending native capture. It no longer reads live text into the observer y-cache or re-extracts
the previous frame. Current and previous text share the subscriber's revision cache. Styled frame
consumers and the Canvas/DOM owned-row path retain their existing projections. Undemanded text
remains lazy. Failed retained extraction discards the pending native capture before retry.

The failing-first real-wasm test detects the redundant live read. It checks dense, scrolling,
Unicode, style and resize output, previous histories, and eager versus lazy demand through forty
frames. Another test injects retained extraction failure and retries different output. Browser
failure injection now targets the retained reader, while rich and supplied-row observer tests
remain. Observer options name only the callbacks and row count that the observer actually uses,
so the same real component can run under plain Node.

This step is held with steps 1 and 2 until main-reference heap is no higher, and dense and scroll
CPU both improve at sixteen terminals on PC and Mac. The exact 50,000-byte ownership guard and
all observer-equality checks remain hard gates. Raw evidence is in
`/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step3/`.

## Cumulative gate passed

The PC run used an owned drain request plus all slot and admission locks. Before/after
queue snapshots show only the pre-existing declared server running; light requests waited.
The Mac used its agent lock and AC power. Both use headed Chromium 153.0.8010.12 on hardware.
CPU is renderer milliseconds per loop at sixteen observed terminals. Figures are experimental
two-pair medians, with 180 measured steps after thirty warmup steps at 200×50 and DPR 2.

| Host/backend  | Workload | CPU before → after | JS heap MiB before → after |
| ------------- | -------- | -----------------: | -------------------------: |
| PC webgl2     | dense    |      26.36 → 21.72 |                7.36 → 7.09 |
| PC webgl2     | scroll   |      13.64 → 10.75 |                7.61 → 6.91 |
| PC webgpu     | dense    |      25.83 → 22.08 |                7.09 → 6.73 |
| PC webgpu     | scroll   |      13.56 → 10.47 |                8.03 → 7.61 |
| Mac M1 webgpu | dense    |      36.76 → 31.29 |                7.05 → 6.50 |
| Mac M1 webgpu | scroll   |      18.80 → 14.98 |                7.75 → 7.64 |

All six normal cells pass: heap is below main and both dense and scroll CPU improve. Wasm
is two MiB lower at sixteen terminals. Row-identity matching is still step 4, so the larger
full-prototype scroll gain is not claimed here.

Every normal, observer-parity and repeated-discard pair has equal checked text, callback,
parsed-write and submitted-frame counts. Observer digests include current and previous text,
styled rows and public frame/text payloads. Presentations and energy are unmeasured.

Repeated-discard CPU improves in every cell, and the documented line-payload recovery heap
increase is removed on both hosts and PC backends. Dense stress WebGPU heap on PC is
6.03 → 7.13 MiB; retain this experimental finding alongside the passing normal gate.

The 38 initial browser failures were old live-read counters. The demand probe now counts
current text projections from both live and retained sources. All 88 demand tests pass with
the output, hold, link and lifetime assertions preserved. The probe is typed at its native-frame
boundary. Full per-layer pre-push qualification is recorded in the PRs.

## Current-main bridge requalification

Main advanced to `cf6994fbc6402258a46333c67af7c6560ce24ad5`, changing the glyph bridge.
The bridge source was merged and both wasm artifacts rebuilt against pinned official upstream
with Zig 0.16.0. Core wasm is unchanged. The combined application was remeasured at
`2ae8e558670efe86453ef7c88672a0d928d64a8c` on both hosts.

| Host/backend  | Workload | Renderer CPU ms before → after | JS heap MiB before → after |
| ------------- | -------- | -----------------------------: | -------------------------: |
| PC webgl2     | dense    |                  25.94 → 23.11 |                7.54 → 7.22 |
| PC webgl2     | scroll   |                   12.58 → 9.61 |                7.43 → 7.12 |
| PC webgpu     | dense    |                  35.17 → 33.47 |                7.41 → 7.21 |
| PC webgpu     | scroll   |                  14.11 → 10.39 |                7.93 → 7.86 |
| Mac M1 webgpu | dense    |                  46.07 → 41.42 |                6.99 → 6.90 |
| Mac M1 webgpu | scroll   |                  23.23 → 18.42 |                8.00 → 7.77 |

All six normal cells pass again. Wasm remains two MiB lower. GPU-process CPU is also retained
in the JSON and raw packets; the dense PC WebGPU packet rises from 20.92 to 23.83 ms there,
while renderer CPU improves. These two-pair measurements are experimental.

The PC recheck again excluded light work with the owned drain and all slot/admission locks.
Both host rechecks retain equal text, callback, write, submission and observer digests. Raw
packets are `pc-cf-{normal,parity,stress}.json` and `mac-cf-{normal,parity,stress}.json` in
the report directory. Earlier source packets remain historical evidence, not the final gate.
