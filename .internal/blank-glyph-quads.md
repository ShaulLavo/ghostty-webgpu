# Blank glyph quads

F9 decision: REJECT. The bridge clears glyph records before examining cells. Empty cells, wide continuations, invisible text and glyphs without ink retain zero width and height. Both GPU vertex shaders already place all six vertices at one point, so these quads cover no fragments. Backgrounds and decorations use a separate cell pass.

An explicit glyph-flag check, tested at `51b47fcaab4ce385d1189d69e6f761613faa4797` against `d2ed8989a745f016188e0a2e749009b3e1450f33`, did not reduce work. Headed hardware probes on the RTX 3060 Ti PC and M1 Mac compared the current vertex shaders with the flag-check variant using opaque diagnostic fragments. Dense redraw, sparse text edits and a mostly-blank screen each gave zero covered blank samples before and after on both backends. Each full-grid probe submitted 480 instances and 2,880 vertices per backend, unchanged by the candidate. This measures covered samples, not hardware fragment invocation counters.

The PC's same-session counterbalanced `bench:renderer` run used Chromium 153.0.8010.12, a non-fallback NVIDIA Ampere adapter, three repetitions and 40 steps. All 18 paired screenshots had identical decoded pixels; bytes, text hashes and requested/submitted frame counts matched. Median CPU percent of one core was mixed:

| Backend | Workload        | Before | Candidate |
| ------- | --------------- | -----: | --------: |
| WebGL2  | cursor movement |  10.24 |      7.32 |
| WebGL2  | burst output    |  11.71 |     10.26 |
| WebGPU  | cursor movement |  13.17 |     11.71 |
| WebGPU  | burst output    |  11.71 |     13.17 |

CPU deltas are experimental; no speedup or GPU-time claim is made. The CPU sparse case moves a cursor rather than editing text; mostly-blank CPU and Mac timing cohorts were not run after proving that the baseline already has zero blank coverage. Production rendering is unchanged for F9.

Raw logs, equal-pixel receipts, the candidate patch and the GPU reproducer remain in `/work/reports/ghostty-webgpu-next-2026-10/f9/`. The reproducer can be copied to `src/render/tests/blank-quads.browser.test.ts` in a matching checkout and run with `GHOSTTY_BROWSER_HARDWARE=1 bun run test:browser src/render/tests/blank-quads.browser.test.ts`.
