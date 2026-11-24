# Terminal comparison benchmarks

This page holds two sets of measurements. The November 2026 set compares ghostty-webgpu 0.3.34 with xterm.js, ghostty-web, Wraith and Restty on a Linux PC and an M1 Mac: CPU across 17 workloads, Mac energy, download size and cold load. The October 2026 set is older and narrower: ghostty-webgpu 0.3.21 against xterm.js only, as paired Mac energy and instruction ratios.

## November 2026: against xterm.js, ghostty-web, Wraith and Restty

Measured 2026-11-24 on ghostty-webgpu 0.3.34 (commit `b4a279a1c`) against xterm.js 6.0.0 (WebGL addon 0.19.0), ghostty-web 0.4.0, Wraith (`wraithterm`) 0.6.1 and Restty 0.3.0, on two machines:

- **PC:** Linux desktop (Wayland), NVIDIA GeForce RTX 3060 Ti, driver 615.78.08; Chromium 153.0.8010.12, headed, hardware GPU (ANGLE OpenGL ES; WebGPU on Vulkan); DPR 1.
- **Mac:** Apple M1 MacBook on AC power; Chromium 153.0.8010.12, headed, hardware GPU (ANGLE Metal); DPR 2.

[Data](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/2026-11-24/results.json) · [Method and how the data was made](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/2026-11-24/README.md)

### Summary

- **CPU.** Our best backend uses more than 10% less whole-browser CPU than the best competitor in 26 of 34 PC cells and 25 of 34 Mac cells, is within 10% in 5 and 8, and loses by more than 10% in 3 and 1. The median ratio, ours over the best competitor, is 0.70 on the PC and 0.77 on the Mac. Our clearest leads are dense output at 16 terminals, repeated identical screens, sparse edits and queued output.
- **Mac energy.** Better by more than 10% in 21 of 34 cells, within 10% in 3, worse in 10. Most losses are to Wraith, on full-screen redraws at 16 terminals and on light one-terminal work.
- **Write acknowledgement p95.** Worse by more than 10% and 0.5 ms in 4 of 34 PC cells and 0 of 34 Mac cells, all heavy 16-terminal parsing.
- **Download size.** Our smallest setup (main, WebGL2) downloads 249.2 KiB brotli. Smaller: xterm.js 84.1, xterm.js with Unicode 11 85.8, ghostty-web 146.1 KiB. Larger: Wraith 879.0, Wraith's xterm profile 826.6, Restty 559.3 KiB.
- **Cold load to first painted terminal.** PC unthrottled: our best 128 ms; faster: ghostty-web 41, Wraith's xterm profile 112 ms. PC Fast 4G: our best 857 ms; faster: Wraith's xterm profile 469, xterm.js 624, xterm.js with Unicode 11 631, ghostty-web 680 ms. Mac unthrottled: our best 99 ms; faster: ghostty-web 61, Wraith's xterm profile 76, xterm.js with Unicode 11 93, xterm.js 97 ms. Mac Fast 4G: our best 864 ms; faster: xterm.js with Unicode 11 501, xterm.js 503, Wraith's xterm profile 504, ghostty-web 728 ms.

### Where a competitor still wins

CPU, PC:

- opentui-plasma at 1 terminal: Wraith WebGPU 0.171 s against our main WebGL2 0.192 s (1.12x)
- glyph-churn at 1 terminal: Restty WebGL2 0.151 s against our main Canvas2D 0.222 s (1.47x)
- cold-cache at 16 terminals: xterm.js WebGL 0.481 s against our main WebGL2 0.573 s (1.19x)

CPU, Mac:

- interactive-edits at 1 terminal: xterm.js WebGL 0.197 s against our main DOM 0.232 s (1.18x)

Mac energy:

- rolling-logs at 1 terminal: Wraith WebGPU 0.135 J against our main WebGL2 0.194 J (1.44x)
- ntcharts-heatmap at 1 terminal: Wraith WebGPU 0.118 J against our worker WebGPU 0.163 J (1.38x)
- ntcharts-heatmap at 16 terminals: Wraith WebGPU 2.630 J against our worker WebGL2 3.153 J (1.20x)
- opentui-plasma at 1 terminal: Wraith WebGPU 0.194 J against our worker WebGPU 0.285 J (1.47x)
- opentui-plasma at 16 terminals: Wraith WebGPU 4.507 J against our pool WebGPU 6.665 J (1.48x)
- synchronized-frames at 1 terminal: Wraith WebGPU 0.044 J against our main WebGPU 0.072 J (1.64x)
- synchronized-frames at 16 terminals: Wraith WebGPU 1.375 J against our main WebGL2 1.591 J (1.16x)
- glyph-churn at 1 terminal: Restty WebGL2 0.216 J against our main Canvas2D 0.291 J (1.35x)
- cold-cache at 16 terminals: xterm.js WebGL 1.757 J against our main DOM 2.160 J (1.23x)
- write-queue-overload at 1 terminal: Wraith WebGPU 0.009 J against our main DOM 0.011 J (1.22x)

Write acknowledgement p95, PC (the Mac has none):

- ntcharts-heatmap at 16 terminals: Wraith WebGPU 1.45 ms against our worker WebGPU 2.25 ms (1.55x)
- opentui-plasma at 16 terminals: Wraith WebGPU 2.85 ms against our worker WebGL2 5.90 ms (2.07x)
- synchronized-frames at 16 terminals: xterm.js WebGL 0.80 ms against our pool WebGPU 1.50 ms (1.88x)
- write-queue-overload at 16 terminals: Wraith WebGPU 22.85 ms against our main DOM 31.95 ms (1.40x)

Forced draw to GPU completion p95 (only ours and Wraith can force a draw), PC:

- opentui-plasma at 1 terminal: Wraith WebGPU 4.70 ms against our main WebGPU 6.55 ms (1.39x)
- glyph-churn at 1 terminal: Wraith WebGPU 4.65 ms against our main WebGL2 7.05 ms (1.52x)

On glyph churn our rasterizer still draws each new glyph twice to detect colour glyphs. Cold cache can only be compared with xterm.js, the one competitor with a public glyph-atlas reset. The acknowledgement losses are all heavy parsing at 16 terminals: our main entry parses on the page's thread before it answers, and our worker pool shares 4 workers across the 16 terminals. One worker per terminal answers sooner but costs about 35 to 60% more CPU, so the pool keeps 4. The one-terminal losses are absolute gaps of a few to 90 milliseconds or millijoules, and those cells move by about 10% between sessions, so they can flip in a repeat.

On the PC, our main-thread WebGPU renderer costs more CPU than our WebGL2 renderer (Chrome on Linux presents each WebGPU canvas separately, which we reproduced without our code), so the auto backend picks WebGL2 on desktop Linux. Main WebGL2 is our best backend in 24 of 34 PC cells and 18 of 34 Mac cells; the tables below show every backend.

### How it was measured

- **Same work for everyone.** Every library gets the same bytes, a 100x30 grid, the same JetBrains Mono Regular TTF at 14 px, the same DPR and a history of 10,000 lines. Each cell is one workload at 1 or 16 terminals, 64 paced steps: write one chunk to every terminal, wait for every library's parse acknowledgement, then wait one display frame. Final screen text is compared across libraries, and a cell whose text differs is excluded.
- **Display check.** Before and after every run each terminal is filled with a known colour and must be on screen, unclipped, uncovered, and actually drawn by the compositor (seen in a browser trace). A run that fails stops before measuring.
- **CPU** is on-CPU time of the whole browser process family (browser, renderer, GPU, utility and worker processes) for the delivered work, not a percentage. Linux sums per-thread `schedstat`; the Mac sums `proc_pid_rusage` user and system time.
- **Mac energy** is the macOS kernel's per-process CPU energy estimate (`proc_pid_rusage`, `RUSAGE_INFO_V6`) over the same process family. It excludes GPU-device, display and whole-system power.
- **Two repetitions** per cell in ABBA order; each value is their mean. Repetition-to-repetition CPU spread was 4% median and 8% at p75, so a gap under 10% counts as even. One-terminal cells are about 0.1 s of CPU and vary by about 10% between sessions.
- **Our arms** were run on `b4a279a1c`. Competitor arms come from a session a few hours earlier on the same machines with the same harness, bytes and page; two of them, xterm.js WebGL and Wraith, were re-run alongside ours as a drift check and moved a median 1.006 (PC) and 0.997 (Mac).
- **Not equal across libraries.** Cell sizes are each library's own (ours and xterm.js 8x21 CSS px, Wraith 8.5x17, Restty 8.5x18.5, ghostty-web 9x16), so ours and xterm.js paint about 19% more pixels than Wraith and ghostty-web. Wraith runs one worker and GPU device per terminal; our worker entry does too, our pool shares 4 workers; our main entry and the others use the page's thread. Ligatures are off and bold is synthesized everywhere.

<details>
<summary>The 17 workloads</summary>

- `rolling-logs`: about 1 MiB of real log output in 4 KiB writes.
- `rolling-unicode-logs`: the same logs with CJK, combining marks and emoji.
- `rolling-slow`: one log line per write.
- `unicode-emoji`: one Unicode and emoji line per write.
- `line-scroll`: one ASCII line per write, scrolling one row each time.
- `interactive-edits`: one row rewritten per write, like typing.
- `ntcharts-heatmap`: full-screen true-colour heatmap frames captured from NTCharts.
- `opentui-plasma`: full-screen half-block plasma frames from OpenTUI, a colour at every cell.
- `synchronized-frames`: dense frames inside synchronized-output brackets (DEC mode 2026).
- `partial-scroll`: scrolling inside a scroll region.
- `insert-delete-lines`: insert-line and delete-line sequences.
- `sparse-edits`: single-cell colour edits spread over the screen.
- `ligature-redraw`: full redraws of operator-heavy code text (ligatures off everywhere).
- `glyph-churn`: a stream of never-seen CJK glyphs and emoji that keeps growing the glyph atlas.
- `cold-cache`: Unicode text with the glyph atlas cleared before every write.
- `repeated-ascii`: the same full ASCII screen written again every step.
- `write-queue-overload`: the whole 1 MiB log corpus queued at once, unpaced.

</details>

### Whole-browser CPU, PC

CPU seconds for the delivered work, lower is better. Each library column is that library's best backend. Bold ratios are losses by more than 10%.

| Workload             | Terminals | ghostty-webgpu (best backend) |       xterm.js |  ghostty-web | Wraith |         Restty | Ours ÷ best other |
| -------------------- | --------: | ----------------------------: | -------------: | -----------: | -----: | -------------: | ----------------: |
| rolling-logs         |         1 |           0.151 (main WebGL2) |  0.182 (WebGL) |        0.465 |  0.151 | 0.353 (WebGL2) |              1.00 |
| rolling-logs         |        16 |           0.504 (main WebGL2) |  0.791 (WebGL) |        5.841 |  1.310 | 1.712 (WebGL2) |              0.64 |
| rolling-unicode-logs |         1 |           0.094 (main WebGL2) |  0.146 (WebGL) |        0.483 |  0.122 | 0.256 (WebGL2) |              0.77 |
| rolling-unicode-logs |        16 |           0.367 (main WebGL2) |  0.779 (WebGL) |        6.053 |  1.283 | 1.472 (WebGL2) |              0.47 |
| rolling-slow         |         1 |              0.085 (main DOM) |  0.123 (WebGL) |        0.225 |  0.110 | 0.123 (WebGL2) |              0.77 |
| rolling-slow         |        16 |           0.187 (main WebGL2) |  0.278 (WebGL) |        2.435 |  1.129 | 0.769 (WebGL2) |              0.67 |
| unicode-emoji        |         1 |           0.092 (main WebGL2) |  0.161 (WebGL) |        0.212 |  0.130 | 0.214 (WebGL2) |              0.71 |
| unicode-emoji        |        16 |           0.215 (main WebGL2) |  0.307 (WebGL) |        2.194 |  1.214 | 0.850 (WebGL2) |              0.70 |
| line-scroll          |         1 |              0.077 (main DOM) |  0.105 (WebGL) |        0.232 |  0.124 | 0.153 (WebGL2) |              0.73 |
| line-scroll          |        16 |           0.186 (main WebGL2) |  0.282 (WebGL) |        2.416 |  1.135 | 0.843 (WebGL2) |              0.66 |
| interactive-edits    |         1 |              0.084 (main DOM) |  0.084 (WebGL) |        0.132 |  0.128 | 0.110 (WebGL2) |              1.00 |
| interactive-edits    |        16 |              0.156 (main DOM) |    0.156 (DOM) |        0.740 |  1.094 | 0.490 (WebGL2) |              1.00 |
| ntcharts-heatmap     |         1 |           0.128 (main WebGL2) |  0.187 (WebGL) |        0.407 |  0.155 | 0.132 (WebGL2) |              0.97 |
| ntcharts-heatmap     |        16 |           0.808 (main WebGL2) |  0.875 (WebGL) |        5.051 |  1.810 | 0.914 (WebGL2) |              0.92 |
| opentui-plasma       |         1 |           0.192 (main WebGL2) |    3.111 (DOM) |        0.854 |  0.171 | 0.235 (WebGL2) |          **1.12** |
| opentui-plasma       |        16 |           1.668 (main WebGL2) | 11.737 (WebGL) |       11.663 |  2.845 | 2.437 (WebGL2) |              0.68 |
| synchronized-frames  |         1 |           0.103 (main WebGL2) |    0.159 (DOM) |        0.663 |  0.172 | 0.193 (WebGL2) |              0.65 |
| synchronized-frames  |        16 |           0.511 (main WebGL2) |  0.873 (WebGL) |        9.312 |  1.325 | 1.699 (WebGL2) |              0.59 |
| partial-scroll       |         1 |           0.079 (pool WebGL2) |  0.088 (WebGL) |        0.327 |  0.111 | 0.153 (WebGL2) |              0.90 |
| partial-scroll       |        16 |           0.238 (main WebGL2) |  0.309 (WebGL) |        4.290 |  1.220 | 0.974 (WebGL2) |              0.77 |
| insert-delete-lines  |         1 |           0.071 (main WebGL2) |  0.085 (WebGL) |        0.305 |  0.107 | 0.144 (WebGL2) |              0.84 |
| insert-delete-lines  |        16 |           0.184 (main WebGL2) |  0.308 (WebGL) |        3.753 |  1.216 | 1.295 (WebGL2) |              0.60 |
| sparse-edits         |         1 |           0.070 (main WebGL2) |    0.123 (DOM) |        0.119 |  0.100 | 0.101 (WebGL2) |              0.70 |
| sparse-edits         |        16 |           0.162 (main WebGL2) |  0.357 (WebGL) |        0.954 |  1.100 | 0.663 (WebGL2) |              0.45 |
| ligature-redraw      |         1 |           0.085 (main WebGL2) |  0.097 (WebGL) |        0.451 |  0.110 | 0.145 (WebGL2) |              0.88 |
| ligature-redraw      |        16 |           0.383 (main WebGL2) |  0.446 (WebGL) |        5.761 |  1.247 | 1.341 (WebGL2) |              0.86 |
| glyph-churn          |         1 |         0.222 (main Canvas2D) |   text differs | text differs |  0.263 | 0.151 (WebGL2) |          **1.47** |
| glyph-churn          |        16 |           0.549 (main WebGL2) |   text differs | text differs |  2.224 | 1.341 (WebGL2) |              0.41 |
| cold-cache           |         1 |              0.058 (main DOM) |  0.114 (WebGL) |          n/a |    n/a |            n/a |              0.51 |
| cold-cache           |        16 |           0.573 (main WebGL2) |  0.481 (WebGL) |          n/a |    n/a |            n/a |          **1.19** |
| repeated-ascii       |         1 |           0.020 (main WebGPU) |  0.099 (WebGL) |        0.485 |  0.118 | 0.177 (WebGL2) |              0.20 |
| repeated-ascii       |        16 |           0.109 (main WebGPU) |  0.361 (WebGL) |        6.596 |  1.206 | 1.578 (WebGL2) |              0.30 |
| write-queue-overload |         1 |           0.007 (main WebGPU) |    0.065 (DOM) |      crashed |  0.019 | 0.011 (WebGPU) |              0.64 |
| write-queue-overload |        16 |           0.060 (main WebGL2) |    0.793 (DOM) |      crashed |  0.186 | 0.153 (WebGPU) |              0.39 |

<details>
<summary>PC CPU seconds: every backend</summary>

| Workload             | Terminals | ours main WebGPU | ours main WebGL2 | ours main Canvas2D | ours main DOM | ours worker WebGPU | ours worker WebGL2 | ours pool WebGPU | ours pool WebGL2 | xterm.js WebGL | xterm.js DOM | ghostty-web Canvas2D | Wraith WebGPU | Restty WebGPU | Restty WebGL2 |
| -------------------- | --------: | ---------------: | ---------------: | -----------------: | ------------: | -----------------: | -----------------: | ---------------: | ---------------: | -------------: | -----------: | -------------------: | ------------: | ------------: | ------------: |
| rolling-logs         |         1 |            0.166 |            0.151 |              0.376 |         0.153 |              0.202 |              0.166 |            0.207 |            0.200 |          0.182 |        0.195 |                0.465 |         0.151 |         0.454 |         0.353 |
| rolling-logs         |        16 |            0.789 |            0.504 |              4.104 |         0.839 |              2.486 |              1.932 |            1.442 |            1.153 |          0.791 |        1.367 |                5.841 |         1.310 |         2.272 |         1.712 |
| rolling-unicode-logs |         1 |            0.123 |            0.094 |              0.393 |         0.139 |              0.163 |              0.141 |            0.159 |            0.144 |          0.146 |        0.204 |                0.483 |         0.122 |         0.296 |         0.256 |
| rolling-unicode-logs |        16 |            0.829 |            0.367 |              3.972 |         0.963 |              2.216 |              1.650 |            1.528 |            1.128 |          0.779 |        1.223 |                6.053 |         1.283 |         2.062 |         1.472 |
| rolling-slow         |         1 |            0.102 |            0.086 |              0.131 |         0.085 |              0.115 |              0.116 |            0.122 |            0.092 |          0.123 |        0.123 |                0.225 |         0.110 |         0.156 |         0.123 |
| rolling-slow         |        16 |            0.592 |            0.187 |              0.932 |         0.383 |              1.288 |              0.760 |            0.866 |            0.447 |          0.278 |        0.529 |                2.435 |         1.129 |         1.429 |         0.769 |
| unicode-emoji        |         1 |            0.127 |            0.092 |              0.170 |         0.127 |              0.148 |              0.171 |            0.166 |            0.120 |          0.161 |        0.247 |                0.212 |         0.130 |         0.324 |         0.214 |
| unicode-emoji        |        16 |            0.615 |            0.215 |              0.797 |         0.993 |              2.012 |              1.464 |            1.389 |            0.898 |          0.307 |        1.868 |                2.194 |         1.214 |         1.598 |         0.850 |
| line-scroll          |         1 |            0.129 |            0.081 |              0.147 |         0.077 |              0.132 |              0.153 |            0.140 |            0.089 |          0.105 |        0.110 |                0.232 |         0.124 |         0.178 |         0.153 |
| line-scroll          |        16 |            0.607 |            0.186 |              0.684 |         0.399 |              1.414 |              0.813 |            0.914 |            0.446 |          0.282 |        0.445 |                2.416 |         1.135 |         1.453 |         0.843 |
| interactive-edits    |         1 |            0.095 |            0.096 |              0.160 |         0.084 |              0.134 |              0.118 |            0.138 |            0.096 |          0.084 |        0.100 |                0.132 |         0.128 |         0.167 |         0.110 |
| interactive-edits    |        16 |            0.568 |            0.166 |              0.473 |         0.156 |              1.148 |              0.545 |            0.849 |            0.349 |          0.224 |        0.156 |                0.740 |         1.094 |         1.144 |         0.490 |
| ntcharts-heatmap     |         1 |            0.151 |            0.128 |              0.194 |         0.804 |              0.199 |              0.166 |            0.172 |            0.138 |          0.187 |        0.847 |                0.407 |         0.155 |         0.178 |         0.132 |
| ntcharts-heatmap     |        16 |            1.264 |            0.808 |              1.630 |        12.956 |              2.391 |              1.790 |            1.604 |            1.174 |          0.875 |       12.182 |                5.051 |         1.810 |         1.581 |         0.914 |
| opentui-plasma       |         1 |            0.205 |            0.192 |              0.803 |         2.824 |              0.236 |              0.221 |            0.246 |            0.203 |          9.494 |        3.111 |                0.854 |         0.171 |         0.302 |         0.235 |
| opentui-plasma       |        16 |            2.100 |            1.668 |             10.270 |        43.303 |              4.100 |              3.522 |            2.612 |            2.231 |         11.737 |       46.440 |               11.663 |         2.845 |         3.028 |         2.437 |
| synchronized-frames  |         1 |            0.156 |            0.103 |              0.490 |         0.146 |              0.169 |              0.117 |            0.169 |            0.131 |          0.469 |        0.159 |                0.663 |         0.172 |         0.246 |         0.193 |
| synchronized-frames  |        16 |            0.947 |            0.511 |              5.943 |         1.290 |              2.112 |              1.506 |            1.399 |            1.019 |          0.873 |        1.060 |                9.312 |         1.325 |         2.361 |         1.699 |
| partial-scroll       |         1 |            0.099 |            0.080 |              0.152 |         0.169 |              0.121 |              0.106 |            0.115 |            0.079 |          0.088 |        0.111 |                0.327 |         0.111 |         0.171 |         0.153 |
| partial-scroll       |        16 |            0.614 |            0.238 |              1.182 |         0.479 |              1.515 |              0.816 |            1.061 |            0.561 |          0.309 |        0.534 |                4.290 |         1.220 |         1.646 |         0.974 |
| insert-delete-lines  |         1 |            0.089 |            0.071 |              0.115 |         0.080 |              0.109 |              0.088 |            0.118 |            0.086 |          0.085 |        0.110 |                0.305 |         0.107 |         0.205 |         0.144 |
| insert-delete-lines  |        16 |            0.571 |            0.184 |              0.785 |         0.339 |              1.276 |              0.614 |            0.916 |            0.419 |          0.308 |        0.513 |                3.753 |         1.216 |         1.996 |         1.295 |
| sparse-edits         |         1 |            0.092 |            0.070 |              0.110 |         0.078 |              0.110 |              0.081 |            0.117 |            0.077 |          0.148 |        0.123 |                0.119 |         0.100 |         0.166 |         0.101 |
| sparse-edits         |        16 |            0.558 |            0.162 |              0.542 |         0.336 |              1.105 |              0.506 |            0.814 |            0.372 |          0.357 |        0.514 |                0.954 |         1.100 |         1.210 |         0.663 |
| ligature-redraw      |         1 |            0.113 |            0.085 |              0.326 |         0.120 |              0.142 |              0.096 |            0.142 |            0.091 |          0.097 |        0.131 |                0.451 |         0.110 |         0.203 |         0.145 |
| ligature-redraw      |        16 |            0.861 |            0.383 |              4.049 |         0.866 |              1.777 |              1.126 |            1.207 |            0.794 |          0.446 |        0.793 |                5.761 |         1.247 |         1.979 |         1.341 |
| glyph-churn          |         1 |            0.262 |            0.239 |              0.222 |         0.409 |              0.399 |              0.302 |            0.320 |            0.291 |   text differs | text differs |         text differs |         0.263 |         0.223 |         0.151 |
| glyph-churn          |        16 |            0.957 |            0.549 |              1.264 |         5.083 |              5.615 |              5.076 |            2.388 |            1.909 |   text differs | text differs |         text differs |         2.224 |         1.913 |         1.341 |
| cold-cache           |         1 |            0.200 |            0.158 |              0.169 |         0.058 |              0.224 |              0.176 |            0.214 |            0.155 |          0.114 |        0.300 |                  n/a |           n/a |           n/a |           n/a |
| cold-cache           |        16 |            1.075 |            0.573 |              1.518 |         0.646 |              3.639 |              2.845 |            1.740 |            1.081 |          0.481 |        3.236 |                  n/a |           n/a |           n/a |           n/a |
| repeated-ascii       |         1 |            0.020 |            0.023 |              0.037 |         0.038 |              0.047 |              0.034 |            0.034 |            0.034 |          0.099 |        0.179 |                0.485 |         0.118 |         0.226 |         0.177 |
| repeated-ascii       |        16 |            0.109 |            0.112 |              0.298 |         0.262 |              0.402 |              0.370 |            0.197 |            0.200 |          0.361 |        0.813 |                6.596 |         1.206 |         2.232 |         1.578 |
| write-queue-overload |         1 |            0.007 |            0.007 |              0.010 |         0.007 |              0.018 |              0.014 |            0.013 |            0.014 |          0.149 |        0.065 |              crashed |         0.019 |         0.011 |         0.028 |
| write-queue-overload |        16 |            0.075 |            0.060 |              0.104 |         0.065 |              0.249 |              0.404 |            0.263 |            0.241 |          0.879 |        0.793 |              crashed |         0.186 |         0.153 |         0.162 |

</details>

### Whole-browser CPU, Mac

| Workload             | Terminals | ghostty-webgpu (best backend) |       xterm.js |  ghostty-web | Wraith |         Restty | Ours ÷ best other |
| -------------------- | --------: | ----------------------------: | -------------: | -----------: | -----: | -------------: | ----------------: |
| rolling-logs         |         1 |           0.375 (main WebGL2) |    0.427 (DOM) |        0.535 |  0.389 | 0.570 (WebGL2) |              0.96 |
| rolling-logs         |        16 |           1.006 (main WebGPU) |  1.514 (WebGL) |        5.453 |  1.692 | 2.655 (WebGL2) |              0.66 |
| rolling-unicode-logs |         1 |           0.297 (main WebGL2) |  0.417 (WebGL) |        0.598 |  0.386 | 0.528 (WebGL2) |              0.77 |
| rolling-unicode-logs |        16 |           0.718 (main WebGL2) |  1.434 (WebGL) |        5.717 |  1.639 | 2.312 (WebGL2) |              0.50 |
| rolling-slow         |         1 |           0.225 (main WebGL2) |    0.324 (DOM) |        0.349 |  0.318 | 0.335 (WebGL2) |              0.71 |
| rolling-slow         |        16 |           0.524 (main WebGPU) |  0.703 (WebGL) |        2.441 |  1.614 | 1.241 (WebGL2) |              0.75 |
| unicode-emoji        |         1 |           0.252 (main WebGL2) |  0.344 (WebGL) |        0.380 |  0.332 | 0.429 (WebGL2) |              0.76 |
| unicode-emoji        |        16 |           0.561 (main WebGPU) |  0.718 (WebGL) |        2.329 |  1.599 | 1.320 (WebGL2) |              0.78 |
| line-scroll          |         1 |           0.235 (main WebGL2) |    0.281 (DOM) |        0.384 |  0.316 | 0.376 (WebGL2) |              0.84 |
| line-scroll          |        16 |           0.510 (main WebGPU) |  0.722 (WebGL) |        2.466 |  1.538 | 1.236 (WebGL2) |              0.71 |
| interactive-edits    |         1 |              0.232 (main DOM) |  0.197 (WebGL) |        0.286 |  0.303 | 0.293 (WebGL2) |          **1.18** |
| interactive-edits    |        16 |              0.351 (main DOM) |    0.339 (DOM) |        0.691 |  1.549 | 0.871 (WebGL2) |              1.04 |
| ntcharts-heatmap     |         1 |           0.287 (main WebGL2) |  0.379 (WebGL) |        0.452 |  0.413 | 0.316 (WebGL2) |              0.91 |
| ntcharts-heatmap     |        16 |           1.321 (main WebGL2) |  1.407 (WebGL) |        5.138 |  2.446 | 1.466 (WebGL2) |              0.94 |
| opentui-plasma       |         1 |           0.395 (main WebGL2) |    2.937 (DOM) |        0.873 |  0.409 | 0.439 (WebGL2) |              0.97 |
| opentui-plasma       |        16 |           2.268 (main WebGPU) | 15.787 (WebGL) |       11.792 |  4.031 | 3.093 (WebGL2) |              0.73 |
| synchronized-frames  |         1 |           0.303 (main WebGL2) |    0.300 (DOM) |        0.655 |  0.367 | 0.440 (WebGL2) |              1.01 |
| synchronized-frames  |        16 |           0.865 (main WebGPU) |    1.191 (DOM) |        8.173 |  1.771 | 2.260 (WebGL2) |              0.73 |
| partial-scroll       |         1 |           0.257 (main WebGL2) |  0.265 (WebGL) |        0.463 |  0.347 | 0.422 (WebGL2) |              0.97 |
| partial-scroll       |        16 |           0.586 (main WebGL2) |  0.764 (WebGL) |        4.285 |  1.594 | 1.513 (WebGL2) |              0.77 |
| insert-delete-lines  |         1 |           0.250 (main WebGL2) |    0.280 (DOM) |        0.433 |  0.337 | 0.327 (WebGL2) |              0.89 |
| insert-delete-lines  |        16 |           0.565 (main WebGL2) |    0.789 (DOM) |        3.618 |  1.583 | 1.902 (WebGL2) |              0.72 |
| sparse-edits         |         1 |           0.256 (main WebGL2) |    0.323 (DOM) |        0.289 |  0.329 | 0.350 (WebGL2) |              0.89 |
| sparse-edits         |        16 |           0.493 (main WebGPU) |    0.826 (DOM) |        0.993 |  1.556 | 1.027 (WebGL2) |              0.60 |
| ligature-redraw      |         1 |           0.259 (main WebGL2) |  0.271 (WebGL) |        0.480 |  0.351 | 0.394 (WebGL2) |              0.96 |
| ligature-redraw      |        16 |           0.748 (main WebGPU) |  0.877 (WebGL) |        5.485 |  1.656 | 1.855 (WebGL2) |              0.85 |
| glyph-churn          |         1 |         0.353 (main Canvas2D) |   text differs | text differs |  0.503 | 0.394 (WebGL2) |              0.90 |
| glyph-churn          |        16 |           1.143 (main WebGPU) |   text differs | text differs |  3.325 | 1.871 (WebGL2) |              0.61 |
| cold-cache           |         1 |              0.246 (main DOM) |  0.349 (WebGL) |          n/a |    n/a |            n/a |              0.70 |
| cold-cache           |        16 |              0.811 (main DOM) |  1.196 (WebGL) |          n/a |    n/a |            n/a |              0.68 |
| repeated-ascii       |         1 |           0.096 (main WebGL2) |  0.270 (WebGL) |        0.542 |  0.304 | 0.423 (WebGL2) |              0.36 |
| repeated-ascii       |        16 |           0.331 (main WebGPU) |  0.945 (WebGL) |        6.175 |  1.407 | 2.228 (WebGL2) |              0.35 |
| write-queue-overload |         1 |           0.014 (main WebGL2) |    0.126 (DOM) |      crashed |  0.013 | 0.030 (WebGPU) |              1.08 |
| write-queue-overload |        16 |           0.087 (main WebGPU) |    0.935 (DOM) |      crashed |  0.406 | 0.172 (WebGPU) |              0.51 |

<details>
<summary>Mac CPU seconds: every backend</summary>

| Workload             | Terminals | ours main WebGPU | ours main WebGL2 | ours main Canvas2D | ours main DOM | ours worker WebGPU | ours worker WebGL2 | ours pool WebGPU | ours pool WebGL2 | xterm.js WebGL | xterm.js DOM | ghostty-web Canvas2D | Wraith WebGPU | Restty WebGPU | Restty WebGL2 |
| -------------------- | --------: | ---------------: | ---------------: | -----------------: | ------------: | -----------------: | -----------------: | ---------------: | ---------------: | -------------: | -----------: | -------------------: | ------------: | ------------: | ------------: |
| rolling-logs         |         1 |            0.416 |            0.375 |              0.479 |         0.396 |              0.478 |              0.497 |            0.499 |            0.471 |          0.452 |        0.427 |                0.535 |         0.389 |         0.697 |         0.570 |
| rolling-logs         |        16 |            1.006 |            1.027 |              3.399 |         1.096 |              3.380 |              2.885 |            2.609 |            2.597 |          1.514 |        1.775 |                5.453 |         1.692 |         2.892 |         2.655 |
| rolling-unicode-logs |         1 |            0.340 |            0.297 |              0.454 |         0.346 |              0.459 |              0.429 |            0.472 |            0.442 |          0.417 |        0.423 |                0.598 |         0.386 |         0.591 |         0.528 |
| rolling-unicode-logs |        16 |            0.790 |            0.718 |              3.149 |         1.223 |              2.868 |              2.469 |            2.553 |            2.445 |          1.434 |        1.686 |                5.717 |         1.639 |         2.727 |         2.312 |
| rolling-slow         |         1 |            0.270 |            0.225 |              0.290 |         0.297 |              0.369 |              0.339 |            0.366 |            0.367 |          0.337 |        0.324 |                0.349 |         0.318 |         0.357 |         0.335 |
| rolling-slow         |        16 |            0.524 |            0.574 |              0.647 |         0.656 |              1.840 |              1.388 |            1.519 |            1.302 |          0.703 |        0.834 |                2.441 |         1.614 |         1.625 |         1.241 |
| unicode-emoji        |         1 |            0.274 |            0.252 |              0.283 |         0.345 |              0.457 |              0.373 |            0.442 |            0.417 |          0.344 |        0.436 |                0.380 |         0.332 |         0.513 |         0.429 |
| unicode-emoji        |        16 |            0.561 |            0.587 |              0.813 |         1.475 |              2.642 |              2.371 |            2.234 |            2.087 |          0.718 |        2.270 |                2.329 |         1.599 |         2.069 |         1.320 |
| line-scroll          |         1 |            0.269 |            0.235 |              0.250 |         0.259 |              0.378 |              0.306 |            0.381 |            0.355 |          0.317 |        0.281 |                0.384 |         0.316 |         0.409 |         0.376 |
| line-scroll          |        16 |            0.510 |            0.549 |              0.644 |         0.673 |              1.945 |              1.429 |            1.522 |            1.355 |          0.722 |        0.795 |                2.466 |         1.538 |         1.695 |         1.236 |
| interactive-edits    |         1 |            0.247 |            0.248 |              0.243 |         0.232 |              0.323 |              0.265 |            0.327 |            0.282 |          0.197 |        0.227 |                0.286 |         0.303 |         0.353 |         0.293 |
| interactive-edits    |        16 |            0.585 |            0.548 |              0.512 |         0.351 |              1.630 |              1.110 |            1.297 |            1.049 |          0.509 |        0.339 |                0.691 |         1.549 |         1.271 |         0.871 |
| ntcharts-heatmap     |         1 |            0.349 |            0.287 |              0.367 |         0.952 |              0.449 |              0.393 |            0.400 |            0.400 |          0.379 |        0.973 |                0.452 |         0.413 |         0.379 |         0.316 |
| ntcharts-heatmap     |        16 |            1.351 |            1.321 |              1.801 |        14.362 |              2.915 |              2.418 |            2.260 |            2.446 |          1.407 |       12.803 |                5.138 |         2.446 |         2.046 |         1.466 |
| opentui-plasma       |         1 |            0.420 |            0.395 |              0.792 |         2.543 |              0.493 |              0.431 |            0.425 |            0.455 |          8.559 |        2.937 |                0.873 |         0.409 |         0.543 |         0.439 |
| opentui-plasma       |        16 |            2.268 |            2.391 |              9.635 |        35.222 |              5.291 |              4.861 |            3.520 |            4.093 |         15.787 |       44.329 |               11.792 |         4.031 |         3.472 |         3.093 |
| synchronized-frames  |         1 |            0.312 |            0.303 |              0.487 |         0.416 |              0.430 |              0.411 |            0.396 |            0.413 |          0.502 |        0.300 |                0.655 |         0.367 |         0.463 |         0.440 |
| synchronized-frames  |        16 |            0.865 |            0.889 |              5.052 |         1.381 |              2.698 |              2.191 |            2.008 |            2.012 |          2.077 |        1.191 |                8.173 |         1.771 |         2.672 |         2.260 |
| partial-scroll       |         1 |            0.289 |            0.257 |              0.309 |         0.283 |              0.384 |              0.304 |            0.382 |            0.337 |          0.265 |        0.293 |                0.463 |         0.347 |         0.441 |         0.422 |
| partial-scroll       |        16 |            0.598 |            0.586 |              1.155 |         0.616 |              1.972 |              1.508 |            1.681 |            1.582 |          0.764 |        0.962 |                4.285 |         1.594 |         1.874 |         1.513 |
| insert-delete-lines  |         1 |            0.280 |            0.250 |              0.279 |         0.253 |              0.345 |              0.354 |            0.348 |            0.335 |          0.291 |        0.280 |                0.433 |         0.337 |         0.444 |         0.327 |
| insert-delete-lines  |        16 |            0.590 |            0.565 |              0.741 |         0.712 |              1.914 |              1.195 |            1.376 |            1.225 |          0.792 |        0.789 |                3.618 |         1.583 |         2.231 |         1.902 |
| sparse-edits         |         1 |            0.271 |            0.256 |              0.289 |         0.286 |              0.358 |              0.293 |            0.348 |            0.331 |          0.415 |        0.323 |                0.289 |         0.329 |         0.381 |         0.350 |
| sparse-edits         |        16 |            0.493 |            0.545 |              0.602 |         0.520 |              1.652 |              1.154 |            1.373 |            1.053 |          0.986 |        0.826 |                0.993 |         1.556 |         1.389 |         1.027 |
| ligature-redraw      |         1 |            0.313 |            0.259 |              0.484 |         0.336 |              0.412 |              0.375 |            0.398 |            0.361 |          0.271 |        0.328 |                0.480 |         0.351 |         0.454 |         0.394 |
| ligature-redraw      |        16 |            0.748 |            0.813 |              3.345 |         1.097 |              2.352 |              1.747 |            1.943 |            1.897 |          0.877 |        1.101 |                5.485 |         1.656 |         2.249 |         1.855 |
| glyph-churn          |         1 |            0.605 |            0.518 |              0.353 |         0.768 |              0.606 |              0.590 |            0.591 |            0.610 |   text differs | text differs |         text differs |         0.503 |         0.486 |         0.394 |
| glyph-churn          |        16 |            1.143 |            1.210 |              1.165 |         5.919 |              7.730 |              8.577 |            3.616 |            4.366 |   text differs | text differs |         text differs |         3.325 |         2.263 |         1.871 |
| cold-cache           |         1 |            0.484 |            0.427 |              0.344 |         0.246 |              0.529 |              0.477 |            0.509 |            0.497 |          0.349 |        0.477 |                  n/a |           n/a |           n/a |           n/a |
| cold-cache           |        16 |            1.244 |            1.201 |              1.679 |         0.811 |              6.103 |              5.202 |            2.757 |            3.050 |          1.196 |        3.816 |                  n/a |           n/a |           n/a |           n/a |
| repeated-ascii       |         1 |            0.105 |            0.096 |              0.133 |         0.136 |              0.173 |              0.161 |            0.163 |            0.170 |          0.270 |        0.317 |                0.542 |         0.304 |         0.462 |         0.423 |
| repeated-ascii       |        16 |            0.331 |            0.333 |              0.546 |         0.478 |              0.999 |              0.992 |            0.731 |            0.718 |          0.945 |        1.149 |                6.175 |         1.407 |         2.559 |         2.228 |
| write-queue-overload |         1 |            0.018 |            0.014 |              0.020 |         0.018 |              0.031 |              0.022 |            0.025 |            0.023 |          0.176 |        0.126 |              crashed |         0.013 |         0.030 |         0.037 |
| write-queue-overload |        16 |            0.087 |            0.107 |              0.147 |         0.093 |              0.370 |              0.350 |            0.323 |            0.359 |          1.154 |        0.935 |              crashed |         0.406 |         0.172 |         0.178 |

</details>

### Mac energy

Joules for the whole browser process family, lower is better.

| Workload             | Terminals | ghostty-webgpu (best backend) |       xterm.js |  ghostty-web | Wraith |         Restty | Ours ÷ best other |
| -------------------- | --------: | ----------------------------: | -------------: | -----------: | -----: | -------------: | ----------------: |
| rolling-logs         |         1 |           0.194 (main WebGL2) |  0.219 (WebGL) |        1.189 |  0.135 | 0.751 (WebGL2) |          **1.44** |
| rolling-logs         |        16 |           1.615 (main WebGL2) |  2.960 (WebGL) |       23.214 |  1.600 | 7.649 (WebGL2) |              1.01 |
| rolling-unicode-logs |         1 |           0.083 (main WebGL2) |  0.145 (WebGL) |        1.085 |  0.146 | 0.430 (WebGL2) |              0.57 |
| rolling-unicode-logs |        16 |           1.142 (main WebGL2) |  2.594 (WebGL) |       24.094 |  1.624 | 6.592 (WebGL2) |              0.70 |
| rolling-slow         |         1 |           0.039 (main WebGL2) |  0.074 (WebGL) |        0.386 |  0.048 | 0.139 (WebGPU) |              0.81 |
| rolling-slow         |        16 |           0.473 (main WebGL2) |  0.893 (WebGL) |        9.780 |  1.271 | 3.257 (WebGL2) |              0.53 |
| unicode-emoji        |         1 |           0.043 (main WebGL2) |  0.080 (WebGL) |        0.370 |  0.056 | 0.329 (WebGL2) |              0.77 |
| unicode-emoji        |        16 |           0.488 (main WebGL2) |  0.908 (WebGL) |        9.311 |  1.214 | 3.356 (WebGL2) |              0.54 |
| line-scroll          |         1 |           0.035 (main WebGL2) |  0.067 (WebGL) |        0.388 |  0.050 | 0.165 (WebGPU) |              0.70 |
| line-scroll          |        16 |           0.402 (main WebGL2) |  0.880 (WebGL) |        9.958 |  0.991 | 3.312 (WebGL2) |              0.46 |
| interactive-edits    |         1 |         0.029 (main Canvas2D) |  0.035 (WebGL) |        0.085 |  0.044 | 0.085 (WebGL2) |              0.83 |
| interactive-edits    |        16 |              0.170 (main DOM) |    0.189 (DOM) |        1.430 |  0.949 | 1.518 (WebGL2) |              0.90 |
| ntcharts-heatmap     |         1 |         0.163 (worker WebGPU) |  0.262 (WebGL) |        1.025 |  0.118 | 0.187 (WebGL2) |          **1.38** |
| ntcharts-heatmap     |        16 |         3.153 (worker WebGL2) |  4.793 (WebGL) |       22.323 |  2.630 | 4.575 (WebGL2) |          **1.20** |
| opentui-plasma       |         1 |         0.285 (worker WebGPU) |    9.369 (DOM) |        2.705 |  0.194 | 0.470 (WebGL2) |          **1.47** |
| opentui-plasma       |        16 |           6.665 (pool WebGPU) | 34.712 (WebGL) |       47.851 |  4.507 | 9.668 (WebGL2) |          **1.48** |
| synchronized-frames  |         1 |           0.072 (main WebGPU) |    0.155 (DOM) |        1.707 |  0.044 | 0.351 (WebGPU) |          **1.64** |
| synchronized-frames  |        16 |           1.591 (main WebGL2) |    3.257 (DOM) |       35.062 |  1.375 | 7.663 (WebGL2) |          **1.16** |
| partial-scroll       |         1 |           0.041 (main WebGL2) |  0.049 (WebGL) |        0.730 |  0.049 | 0.228 (WebGL2) |              0.84 |
| partial-scroll       |        16 |           0.624 (main WebGL2) |  1.169 (WebGL) |       18.378 |  1.260 | 4.551 (WebGL2) |              0.53 |
| insert-delete-lines  |         1 |           0.028 (main WebGL2) |  0.048 (WebGL) |        0.601 |  0.046 | 0.206 (WebGL2) |              0.61 |
| insert-delete-lines  |        16 |           0.462 (main WebGL2) |  1.435 (WebGL) |       15.339 |  1.136 | 5.794 (WebGL2) |              0.41 |
| sparse-edits         |         1 |           0.025 (main WebGL2) |    0.097 (DOM) |        0.091 |  0.036 | 0.097 (WebGL2) |              0.69 |
| sparse-edits         |        16 |           0.368 (main WebGL2) |  1.355 (WebGL) |        2.714 |  0.912 | 2.154 (WebGL2) |              0.40 |
| ligature-redraw      |         1 |           0.050 (main WebGL2) |  0.070 (WebGL) |        1.076 |  0.046 | 0.243 (WebGPU) |              1.09 |
| ligature-redraw      |        16 |           1.030 (main WebGL2) |  1.810 (WebGL) |       23.638 |  1.210 | 6.100 (WebGL2) |              0.85 |
| glyph-churn          |         1 |         0.291 (main Canvas2D) |   text differs | text differs |  0.363 | 0.216 (WebGL2) |          **1.35** |
| glyph-churn          |        16 |           2.180 (main WebGPU) |   text differs | text differs |  4.291 | 5.385 (WebGL2) |              0.51 |
| cold-cache           |         1 |              0.090 (main DOM) |  0.085 (WebGL) |          n/a |    n/a |            n/a |              1.06 |
| cold-cache           |        16 |              2.160 (main DOM) |  1.757 (WebGL) |          n/a |    n/a |            n/a |          **1.23** |
| repeated-ascii       |         1 |           0.014 (main WebGL2) |  0.066 (WebGL) |        1.192 |  0.040 | 0.309 (WebGPU) |              0.35 |
| repeated-ascii       |        16 |           0.212 (main WebGPU) |  1.902 (WebGL) |       26.282 |  1.046 | 7.329 (WebGL2) |              0.20 |
| write-queue-overload |         1 |              0.011 (main DOM) |    0.254 (DOM) |      crashed |  0.009 | 0.034 (WebGPU) |          **1.22** |
| write-queue-overload |        16 |           0.231 (main WebGPU) |    2.954 (DOM) |      crashed |  0.568 | 0.498 (WebGPU) |              0.46 |

<details>
<summary>Mac energy: every backend</summary>

| Workload             | Terminals | ours main WebGPU | ours main WebGL2 | ours main Canvas2D | ours main DOM | ours worker WebGPU | ours worker WebGL2 | ours pool WebGPU | ours pool WebGL2 | xterm.js WebGL | xterm.js DOM | ghostty-web Canvas2D | Wraith WebGPU | Restty WebGPU | Restty WebGL2 |
| -------------------- | --------: | ---------------: | ---------------: | -----------------: | ------------: | -----------------: | -----------------: | ---------------: | ---------------: | -------------: | -----------: | -------------------: | ------------: | ------------: | ------------: |
| rolling-logs         |         1 |            0.251 |            0.194 |              0.620 |         0.227 |              0.251 |              0.235 |            0.243 |            0.261 |          0.219 |        0.339 |                1.189 |         0.135 |         1.152 |         0.751 |
| rolling-logs         |        16 |            1.693 |            1.615 |             12.656 |         2.780 |              3.686 |              3.595 |            2.841 |            2.826 |          2.960 |        4.712 |               23.214 |         1.600 |         7.943 |         7.649 |
| rolling-unicode-logs |         1 |            0.100 |            0.083 |              0.468 |         0.181 |              0.141 |              0.128 |            0.143 |            0.131 |          0.145 |        0.269 |                1.085 |         0.146 |         0.583 |         0.430 |
| rolling-unicode-logs |        16 |            1.259 |            1.142 |             11.017 |         3.283 |              2.974 |              2.757 |            2.747 |            2.702 |          2.594 |        4.787 |               24.094 |         1.624 |         7.187 |         6.592 |
| rolling-slow         |         1 |            0.047 |            0.039 |              0.065 |         0.099 |              0.062 |              0.054 |            0.067 |            0.059 |          0.074 |        0.095 |                0.386 |         0.048 |         0.139 |         0.184 |
| rolling-slow         |        16 |            0.547 |            0.473 |              0.839 |         0.927 |              1.243 |              1.153 |            1.014 |            1.009 |          0.893 |        1.566 |                9.780 |         1.271 |         3.859 |         3.257 |
| unicode-emoji        |         1 |            0.059 |            0.043 |              0.077 |         0.198 |              0.102 |              0.136 |            0.124 |            0.122 |          0.080 |        0.328 |                0.370 |         0.056 |         0.549 |         0.329 |
| unicode-emoji        |        16 |            0.598 |            0.488 |              1.145 |         4.023 |              2.965 |              2.840 |            2.440 |            2.504 |          0.908 |        6.729 |                9.311 |         1.214 |         4.446 |         3.356 |
| line-scroll          |         1 |            0.044 |            0.035 |              0.039 |         0.057 |              0.060 |              0.072 |            0.062 |            0.054 |          0.067 |        0.083 |                0.388 |         0.050 |         0.165 |         0.209 |
| line-scroll          |        16 |            0.568 |            0.402 |              0.810 |         1.058 |              1.226 |              1.249 |            0.880 |            0.922 |          0.880 |        1.570 |                9.958 |         0.991 |         3.896 |         3.312 |
| interactive-edits    |         1 |            0.044 |            0.042 |              0.029 |         0.033 |              0.056 |              0.061 |            0.052 |            0.047 |          0.035 |        0.044 |                0.085 |         0.044 |         0.100 |         0.085 |
| interactive-edits    |        16 |            0.556 |            0.369 |              0.316 |         0.170 |              0.861 |              0.688 |            0.690 |            0.662 |          0.334 |        0.189 |                1.430 |         0.949 |         2.075 |         1.518 |
| ntcharts-heatmap     |         1 |            0.180 |            0.172 |              0.322 |         2.730 |              0.163 |              0.190 |            0.177 |            0.163 |          0.262 |        2.461 |                1.025 |         0.118 |         0.207 |         0.187 |
| ntcharts-heatmap     |        16 |            4.293 |            4.259 |              6.869 |        48.217 |              3.465 |              3.153 |            3.848 |            3.649 |          4.793 |       45.099 |               22.323 |         2.630 |         5.353 |         4.575 |
| opentui-plasma       |         1 |            0.295 |            0.333 |              2.063 |         8.656 |              0.285 |              0.315 |            0.350 |            0.308 |         21.662 |        9.369 |                2.705 |         0.194 |         0.476 |         0.470 |
| opentui-plasma       |        16 |            7.104 |            6.954 |             37.560 |       119.293 |              6.755 |              6.736 |            6.665 |            7.144 |         34.712 |      153.512 |               47.851 |         4.507 |        10.115 |         9.668 |
| synchronized-frames  |         1 |            0.072 |            0.075 |              0.955 |         0.378 |              0.110 |              0.082 |            0.115 |            0.092 |          0.418 |        0.155 |                1.707 |         0.044 |         0.351 |         0.436 |
| synchronized-frames  |        16 |            1.618 |            1.591 |             20.025 |         4.961 |              2.601 |              2.346 |            2.161 |            2.186 |          3.844 |        3.257 |               35.062 |         1.375 |         8.066 |         7.663 |
| partial-scroll       |         1 |            0.047 |            0.041 |              0.112 |         0.060 |              0.062 |              0.051 |            0.064 |            0.053 |          0.049 |        0.078 |                0.730 |         0.049 |         0.236 |         0.228 |
| partial-scroll       |        16 |            0.741 |            0.624 |              2.634 |         1.055 |              1.400 |              1.102 |            1.221 |            1.330 |          1.169 |        1.999 |               18.378 |         1.260 |         5.080 |         4.551 |
| insert-delete-lines  |         1 |            0.036 |            0.028 |              0.059 |         0.050 |              0.050 |              0.033 |            0.056 |            0.042 |          0.048 |        0.070 |                0.601 |         0.046 |         0.238 |         0.206 |
| insert-delete-lines  |        16 |            0.658 |            0.462 |              1.071 |         0.888 |              0.983 |              0.805 |            0.868 |            0.872 |          1.435 |        1.509 |               15.339 |         1.136 |         6.162 |         5.794 |
| sparse-edits         |         1 |            0.032 |            0.025 |              0.038 |         0.061 |              0.036 |              0.034 |            0.039 |            0.030 |          0.110 |        0.097 |                0.091 |         0.036 |         0.101 |         0.097 |
| sparse-edits         |        16 |            0.472 |            0.368 |              0.414 |         0.740 |              0.837 |              0.658 |            0.696 |            0.781 |          1.355 |        1.802 |                2.714 |         0.912 |         2.622 |         2.154 |
| ligature-redraw      |         1 |            0.057 |            0.050 |              0.530 |         0.129 |              0.083 |              0.062 |            0.082 |            0.084 |          0.070 |        0.157 |                1.076 |         0.046 |         0.243 |         0.254 |
| ligature-redraw      |        16 |            1.173 |            1.030 |             12.817 |         2.449 |              1.940 |              1.723 |            1.662 |            1.820 |          1.810 |        3.121 |               23.638 |         1.210 |         6.584 |         6.100 |
| glyph-churn          |         1 |            0.593 |            0.460 |              0.291 |         1.026 |              0.583 |              0.620 |            0.587 |            0.618 |   text differs | text differs |         text differs |         0.363 |         0.258 |         0.216 |
| glyph-churn          |        16 |            2.180 |            2.352 |              2.604 |        17.925 |             11.288 |             12.354 |            6.179 |            6.801 |   text differs | text differs |         text differs |         4.291 |         5.930 |         5.385 |
| cold-cache           |         1 |            0.239 |            0.209 |              0.214 |         0.090 |              0.253 |              0.239 |            0.257 |            0.217 |          0.085 |        0.530 |                  n/a |           n/a |           n/a |           n/a |
| cold-cache           |        16 |            2.539 |            2.844 |              5.616 |         2.160 |              7.056 |              6.792 |            3.324 |            3.742 |          1.757 |       12.100 |                  n/a |           n/a |           n/a |           n/a |
| repeated-ascii       |         1 |            0.017 |            0.014 |              0.030 |         0.018 |              0.022 |              0.019 |            0.024 |            0.032 |          0.066 |        0.132 |                1.192 |         0.040 |         0.309 |         0.317 |
| repeated-ascii       |        16 |            0.212 |            0.242 |              0.697 |         0.519 |              0.403 |              0.429 |            0.285 |            0.317 |          1.902 |        3.259 |               26.282 |         1.046 |         7.762 |         7.329 |
| write-queue-overload |         1 |            0.013 |            0.018 |              0.015 |         0.011 |              0.025 |              0.031 |            0.028 |            0.029 |          0.314 |        0.254 |              crashed |         0.009 |         0.034 |         0.040 |
| write-queue-overload |        16 |            0.231 |            0.247 |              0.426 |         0.257 |              0.595 |              0.561 |            0.702 |            0.649 |          3.219 |        2.954 |              crashed |         0.568 |         0.498 |         0.526 |

</details>

### Download size

KiB that one terminal on its best renderer downloads, built with the same Vite production config and logged by the server while the page loads in Chromium. Brotli is quality 11. Fonts are counted separately: xterm.js, ghostty-web and our main entry draw with the page's `monospace` font; our worker entry and Restty get the same 21 KiB woff2, and Wraith fetches its bundled TTF.

| App                                    | Renderer     |    Raw |   gzip | Brotli | Font file (wire) | Brotli + font |
| -------------------------------------- | ------------ | -----: | -----: | -----: | ---------------: | ------------: |
| ghostty-webgpu main, auto backend      | webgl2       | 1019.1 |  308.7 |  252.7 |                - |         252.7 |
| ghostty-webgpu main, WebGPU            | webgpu       | 1030.9 |  310.3 |  252.6 |                - |         252.6 |
| ghostty-webgpu main, WebGL2            | webgl2       | 1013.9 |  306.5 |  249.2 |                - |         249.2 |
| ghostty-webgpu worker, auto backend    | webgl2       | 1074.2 |  324.2 |  267.3 |             20.7 |         288.0 |
| ghostty-webgpu worker, WebGPU          | webgpu       | 1086.8 |  327.1 |  270.0 |             20.7 |         290.6 |
| ghostty-webgpu worker, WebGL2          | webgl2       | 1074.2 |  324.2 |  267.3 |             20.7 |         287.9 |
| xterm.js 6 + WebGL addon               | webgl2       |  439.3 |  111.7 |   84.1 |                - |          84.1 |
| xterm.js 6 + WebGL + Unicode 11 addons | webgl2       |  463.9 |  119.9 |   85.8 |                - |          85.8 |
| ghostty-web 0.4.0 (Canvas 2D)          | canvas2d     |  621.9 |  181.7 |  146.1 |                - |         146.1 |
| Wraith 0.6.1 native (worker, WebGPU)   | webgpu       | 2964.0 | 1045.0 |  775.7 |            103.3 |         879.0 |
| Wraith 0.6.1 xterm profile             | dom → webgpu | 3237.9 | 1108.4 |  826.6 |                - |         826.6 |
| Restty 0.3.0 (WebGPU, WebGL2 fallback) | webgpu       | 2748.9 |  682.1 |  538.7 |             20.7 |         559.3 |

### Cold load

Milliseconds from navigation to the first compositor frame that shows the probe text, median (p95) of 10 runs, each in a fresh headed Chromium profile with no HTTP or code cache. Fast 4G adds 165 ms before every response and shares a 1.01 MB/s downlink. The auto backend is WebGL2 on the PC and WebGPU on the Mac. On Fast 4G our main entry pays for two serial round trips and an external wasm file; libraries that ship no wasm or inline it start sooner. Unthrottled WebGL2 first paint on the PC is bimodal, about 222 or 270 ms per load, for xterm.js too.

| App                                    | PC unthrottled |  PC Fast 4G | Mac unthrottled | Mac Fast 4G |
| -------------------------------------- | -------------: | ----------: | --------------: | ----------: |
| ghostty-webgpu main, auto backend      |      252 (396) |  861 (1012) |       101 (178) |   864 (879) |
| ghostty-webgpu main, WebGPU            |      128 (138) |   871 (872) |       104 (131) |   882 (888) |
| ghostty-webgpu main, WebGL2            |      267 (279) |   857 (870) |        99 (315) |   877 (884) |
| ghostty-webgpu worker, auto backend    |      235 (291) | 1436 (1458) |       130 (224) | 1294 (1304) |
| ghostty-webgpu worker, WebGPU          |      138 (151) | 1240 (1249) |       127 (293) | 1294 (1429) |
| ghostty-webgpu worker, WebGL2          |      231 (244) | 1435 (1449) |       123 (147) | 1314 (1333) |
| xterm.js 6 + WebGL addon               |      269 (277) |   624 (674) |        97 (111) |   503 (521) |
| xterm.js 6 + WebGL + Unicode 11 addons |      264 (273) |   631 (684) |        93 (133) |   501 (524) |
| ghostty-web 0.4.0 (Canvas 2D)          |        41 (46) |   680 (687) |        61 (129) |   728 (747) |
| Wraith 0.6.1 native (worker, WebGPU)   |      155 (167) | 1596 (1662) |       151 (168) | 1659 (1698) |
| Wraith 0.6.1 xterm profile             |      112 (131) |   469 (492) |        76 (116) |   504 (513) |
| Restty 0.3.0 (WebGPU, WebGL2 fallback) |      176 (190) | 1215 (1238) |       139 (176) | 1253 (1277) |

### What could not be measured

- xterm.js 6 has no canvas renderer, and our worker entry offers only WebGPU and WebGL2.
- Cold cache needs a public glyph-atlas reset, which only ours and xterm.js have.
- ghostty-web's wasm crashes on write-queue-overload (`memory access out of bounds`) at 1 and 16 terminals.
- On glyph churn, xterm.js measures 🧪 as one cell and ghostty-web's final rows are wrong, so their cells are excluded.

## October 2026: Mac energy pairs against xterm.js

These are instrumented whole-terminal measurements of ghostty-webgpu 0.3.21 (Fregat commit `fb67ac08ded224fd6579389a23796e015ee23d5c`). They measure CPU work and estimated CPU energy while terminals receive paced output, and they show workload-specific results from one Mac on the evening of 2026-10-09 UTC. Later builds are not measured in this section.

Every ratio is ghostty divided by xterm.js. Below 1 means ghostty uses less. Energy and instructions are the efficiency metrics. CPU seconds appear for context. Apple Silicon changes its clock speed with load, so a run that does less work can take more CPU seconds.

[Scores](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/scores.json) · [Method and recompute](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/README.md) · [Offline verifier](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/verify.mjs)

### WebGL vs xterm.js WebGL

Apple M1 MacBook, AC power, headed Chrome 154.0.8037.93, hardware ANGLE Metal GPU. Acquired 2026-10-09 UTC, reviewed 2026-10-10. ghostty-webgpu 0.3.21; xterm.js 6.0.0 with WebGL addon 0.19.0, plus its Unicode 11 addon 0.9.0 on one Unicode line per tick. 40 × 12 cells, DPR 2, a 560 × 456-pixel drawing buffer for both libraries, 17 visible terminals. Each workload has 120 warm-up ticks and 900 measured ticks paced at 60 Hz. Each row is the median of two balanced pair ratios from one browser session, and every workload ran in its own session. Counters cover the endpoint-enumerated Chrome process family, including GPU-process CPU work.

| Workload                  | History          | CPU energy ratio | Instruction ratio | CPU seconds ratio | Pairs                                            | Evidence                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------------- | ---------------: | ----------------: | ----------------: | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Heavy log output          | 8,841 final rows |            0.612 |             0.613 |             0.759 | Lower in both pairs                              | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-rolling-logs.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)         |
| Heavy Unicode output      | 9,572 final rows |            0.611 |             0.615 |             0.761 | Lower in both pairs                              | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-rolling-unicode-logs.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json) |
| One Unicode line per tick | 889 rows         |            0.986 |             1.002 |             0.989 | Energy lower, instructions higher, in both pairs | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-unicode-emoji.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)        |
| One ASCII line per tick   | 889 rows         |            0.955 |             0.985 |             0.991 | Lower in both pairs                              | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-line-scroll.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)          |
| Typing-like edits         | 0 rows           |            0.911 |             0.954 |             1.011 | Lower in both pairs                              | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/webgl-interactive-edits.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)    |

WebGL uses 39% less estimated CPU energy and 39% fewer instructions on heavy log output. The same two figures are 39% and 39% on heavy Unicode output, 5% and 1% on one ASCII line per tick and 9% and 5% on typing-like edits. One ASCII line per tick is the `line-scroll` workload: each tick appends one line, so the screen scrolls one row per tick. Its margins and the edits margins are small and come from two pairs per cell.

One Unicode line per tick is even. Energy is 1.4% lower in both pairs and instructions are 0.2% higher in both pairs.

The bounded log workloads finish with matching retained text and equal history: 8,841 rows per terminal for heavy log output and 9,572 for heavy Unicode output. The check compares final retained output. It does not prove equal intermediate retention or identical rasters.

### DOM vs xterm.js DOM

Same machine, browser, build and dates. ghostty-webgpu 0.3.21 DOM against xterm.js 6.0.0 DOM. Both use a normalized 360 × 288 CSS-pixel surface, a 15px font and hidden scrollbars. 40 × 12 cells, DPR 2, 17 visible terminals, 120 warm-up ticks and 900 measured ticks at 60 Hz. Ratios are medians of two balanced pairs of all-Chrome counter deltas.

| Workload                | History          | CPU energy ratio | Instruction ratio | CPU seconds ratio | Pairs                      | Evidence                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------- | ---------------: | ----------------: | ----------------: | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heavy log output        | 8,841 final rows |            0.529 |             0.592 |             0.702 | Lower in both pairs        | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/dom-rolling-logs.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)         |
| Heavy Unicode output    | 9,572 final rows |            0.592 |             0.618 |             0.704 | Lower in both pairs        | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/dom-rolling-unicode-logs.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json) |
| One ASCII line per tick | 889 rows         |            0.669 |             0.799 |             0.976 | Lower in both pairs        | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/dom-line-scroll.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)          |
| Typing-like edits       | 0 rows           |            1.008 |             0.998 |             1.022 | Mixed across the two pairs | [Counters](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/counters/dom-interactive-edits.json) · [Review](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/reviews/r12-standing-mac.json)    |

DOM uses 47% less estimated CPU energy and 41% fewer instructions on heavy log output. The same two figures are 41% and 38% on heavy Unicode output and 33% and 20% on one ASCII line per tick. Typing-like edits are even: median energy is 0.8% higher, median instructions are 0.2% lower, and the two pairs disagree on both energy and instructions.

One Unicode line per tick is unavailable for DOM: xterm.js DOM settled to two different images within the same actor in both attempts, so the equal-output check failed. No qualified comparison exists.

### Not published in this set

The October set pairs each renderer with the same kind of xterm.js renderer, so it has WebGL and DOM tables only. Its Canvas, WebGPU, Linux and Raspberry Pi 4 runs are not published. xterm.js has no WebGPU renderer, so a WebGPU row would be a cross-API comparison.

### Method limits

Energy is the macOS kernel's per-process CPU energy estimate from `proc_pid_rusage` with `RUSAGE_INFO_V6`. It includes GPU-process CPU work, and excludes GPU-device, display, non-Chrome and whole-system power. Instructions are retired CPU instructions across the same process family. Cycles, CPU seconds, core placement and effective clocks are diagnostics. The M1 runs light work on its efficiency cores, so a terminal that does less work can show more cycles.

Each cell has two chronological ghostty and xterm.js pairs, ordered ABBA or BAAB. A browser session shares windows between renderers, so the two windows of a pair need not be adjacent. Two pairs give descriptive observations. They carry no significance test. The benchmark observer is enabled and its overhead is not calibrated, so none is subtracted.

Native snapshots bracket the reset, paced writes, logical settlement through two animation frames, and target-counter snapshots. Text and screenshots are captured afterwards. This endpoint proves logical settlement; it does not prove physical presentation. Stable PID, type and start identities at the endpoints cannot capture a process born and gone entirely between samples. Samples are sequential and non-atomic.

These tables do not support a claim that ghostty is faster on every workload. Each saved record preserves per-process counter deltas, output digests and work counts. Recompute every ratio with `node docs/benchmarks/mac-m1-2026-10-10/verify.mjs`, from `ghostty-webgpu/`.

## Memory

A fair memory comparison covers the whole browser process family, including resident WebAssembly memory. Report the idle baseline, retained-history phase and their delta, along with actual retained rows. GPU-device allocations need a separate measurement and label. Avoid adding WASM capacity to RSS, which already includes resident WASM pages.

This page makes no numeric memory claim.
