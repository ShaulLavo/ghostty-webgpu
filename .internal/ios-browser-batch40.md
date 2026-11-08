# Complete displayed-frame boundaries preparation

Status: Approved source preparation. Assigned merged base is
3ad7fa6088d3ef2dcc81d19f1094ae22c424ea7f. This batch selects only complete
src/dom/tests/displayed-frame-boundaries.browser.test.ts.

The current original expands to 18 cases. It keeps every original byte, native
state, actual WebGL and WebGPU path, DeferredClock callback, queueMicrotask spy,
recovery action, snapshot oracle, accessibility poll and awaited reverse cleanup.
The sole new stage is displayed-frame-boundaries. All cases keep the ordinary
15,000 ms default with zero retries. No provider operation or clock changes.

The report packet is under
/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch40/.
Parent owns independent review, CI acceptance, merge, main CI and native intake.
No native, Mac or Device resource is allocated by preparation. Waffle remains
published 0.0.111. PR 108 is separate and unadopted.

All 18 cases passed in one ordinary complete-file desktop execution. The 127
normally discovered adapter tests and all prerequisite gates passed. Forty
saved-data controls passed without original replay. Checked teardown removed
all owned installs and outputs. This is not native Safari qualification.
