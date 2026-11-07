# Original browser batch 01

Status: Approved source preparation. Native execution is not claimed.

The write claim covers three complete original files at base
`fdb2336f4343c4746df9ec382a24ee43212a8c44`:

- `src/dom/tests/write-queue.browser.test.ts`, five cases.
- `src/dom/tests/presentation.browser.test.ts`, three cases including both original parameters.
- `src/dom/tests/scrollbar-async.browser.test.ts`, one case.

These files cover asynchronous write, paint, and scroll ownership. Their original bodies,
hooks, loops, assertions, options, geometry, assets, and clocks remain unchanged.
The existing stage parser, independent ExpectedCase manifests, source hashes, and result
verifier own the preparation. No host or controller operation is added.

The desktop validation runs each whole file once through ordinary discovery. A later
parent-owned Safari turn runs the three stages sequentially. Host exit 4 and verifier
exit 0 remain selected-file evidence only, with whole-root completion false.

The fixed exclusion authority remains 35 touch cases and 16 not-applicable cases.
No exclusion or denominator changes. Font, viewport, bulk snapshot, and the parent-owned
measurement campaign are outside this batch.

The portable packet and exact validation evidence belong to
`/work/reports/wave-20261107/ios-suites/ghostty-original-batch-01/`.
