# Complete original pixel damage preparation

Status is Approved preparation, not native qualification.

Batch 08 claims only `src/render/pixels/damage.browser.test.ts`, all five expanded
cases. The four DPR rows and inherited-filter scroll case remain unchanged.
Preparation preserves the real runtime, Canvas painter and renderer, fitted font,
manual TestClock maps, every callback, cleanup, loop and exact RGBA assertion.

The pre-implementation import and asset inspection found no whole-file provider
boundary. The fixture module defines an unused screenshot helper, but this original
imports and calls TestClock only. No imports or fixture definitions are removed.
The published Waffle 0.0.111 archive gate passed without pin or host changes.

Twelve completed originals stay frozen. Batch 06 was attempted natively and failed
adapter completion despite eight passing bodies. It is not complete and must not
be replayed. Batch 07 is merged but native-unrun and cannot be selected again.
Fixed exclusions remain 35 touch and 16 N/A. No registry write is made.

The parent owns independent review, CI, merge, main CI and native scheduling.
The packet is retained at
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch08/packet/`.
