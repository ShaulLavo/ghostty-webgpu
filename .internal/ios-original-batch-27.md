# Complete managed renderer fallback original

Status: Approved source preparation, in progress.

Select only `src/render/tests/fallback.browser.test.ts` at merged main
`32c17b8a19cae99d4e48c930d5412863570261d6`. The complete file has six
cases, including dispose and abort parameter rows and the top-level reduced-motion case.
All original bytes, clocks, mocks, native frame-builder attachment and cleanup remain unchanged.

The source graph has 87 modules, 356 edges and four Wasm assets. It includes
unused screenshot helpers, alternate renderers, optional bidi and pixel composition.
The actual fallback cases read Canvas2D pixels directly and never call the screenshot
helper, a viewport command or a trusted-input provider command. No worker is opened
and no font is fetched. The fitted font uses the browser's monospace family.

Preparation evidence belongs to
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch27/`.
Parent owns independent review, CI acceptance, merge, main gate and native handoff.
No native completion is claimed. The fixed 35 touch and 16 N/A rows are unchanged.

Fresh canonical discovery found fifteen completed originals, including the newly
recorded mounted-scroll file, and 174 native receipts. Receipt growth alone does
not establish completion. Batch 06 remains failed and unavailable for replay.
Batch 13 remains blocked at `src/render/tests/worker-renderer.browser.test.ts`.
