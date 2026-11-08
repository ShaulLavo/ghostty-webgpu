# Complete canvas-image preparation

Status: Approved, preparation in progress. This batch selects only complete
`src/dom/tests/canvas-image.browser.test.ts` at merged base
`34378d49718828ba793e15e68e7ffd96ac6aa19d`.

The `canvas-image` stage retains all 38 cases, every original byte and all backend
rows. Test and hook timeouts remain 15,000 ms and 30,000 ms with zero retries.
No renderer, runtime, provider, original, helper, pin, lock or exclusion changes.
Waffle remains published 0.0.111. PR 108 is not consumed.

The source uses actual built Terminal and renderers, direct owned canvas copies,
original TestClock callbacks and real animation frames. Its imported screenshot
helper is unused. No provider screenshot replaces canvas-image observations.
The pixels row loads the existing compositor. Bidi, ligatures and worker
execution are not selected. Monospace is a browser font, not a font download.

Packet and pre-entry evidence are under
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch37/`.
Parent owns independent review, CI acceptance, merge, main CI and native intake.
No native, Mac or Device resources are allocated by preparation.
