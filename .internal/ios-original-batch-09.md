# Complete mounted-scroll original preparation

Status: Approved. Batch 09 claims only `src/render/canvas/mounted-scroll.browser.test.ts`.

The original registers two cases with `it.each`, for `canvas2d-fill-text` and
`canvas2d-pixels`. Keep the complete original and normal import graph unchanged.
The public Terminal mounts a real Canvas renderer with the original TestClock.
Metrics and full-reference RGBA remain the oracle.

The published Waffle 0.0.111 archive passed its unchanged byte and digest gate
before implementation. The selected original calls no provider operation. Its
shared fixture defines `displayedPixels`, but only TestClock is imported and used.
The screenshot helper is not called at import time or by this original.

Preparation evidence and the parent intake instructions belong under
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch09/`.
No native execution, replay, root-suite credit, provider change, or new exclusion
is authorized by this preparation. The parent owns review, CI, merge, and intake.
