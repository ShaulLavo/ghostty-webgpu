# Complete worker write queue preparation

Status: Approved, preparation in progress. This claims only complete
`src/worker/write-queue.browser.test.ts` at merged base
`6f6dcd174e98726ebdcfd2397725135ee59c824f` for batch 30.

The original has four cases. The stage must preserve its real worker, WebGL,
font, MessagePort spy, write batching, cancellation, disposal and browser clocks.
No source, helper, assertion, provider operation, package pin or exclusion changes
are authorized. Waffle remains published 0.0.111.

Evidence belongs to
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch30/`.
Parent owns independent review, CI acceptance, merge and native intake.
