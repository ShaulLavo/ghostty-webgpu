# Selective discard final qualification

Status: Qualified. The existing selective ledger passes the final recovery gate. This lane step derives from merged #44
on current main. It does not include the rejected two-slot design.

Selective invalidation already shipped in #35: each pending attempt tracks revisions it first
inserted, and discard deletes only those entries plus that slot's revision list. Three native
slots remain. This PR adds no duplicate invalidation mechanism and no worker transport.

The new real-wasm regression repeats 32 moved-row abandonment/retry cycles for two subscribers.
One accepts abandoned output at a different cadence; the other always discards, including a
failure injected after insertion. Every retry checks current and independent previous rows,
accepted cell/continuation identity, zero previous-text extraction and immutable earlier rows.
The all-clear negative control fails both cases at the unwanted re-extraction guard. Source is
restored on every test exit, and the selective implementation passes ownership and rollover tests.

The hardware before arm is a separately committed all-clear control based on the same current
main. Its only production difference is replacing selective deletion with clearing the entire
cache and revision lists. The after arm uses main's existing selective implementation. Normal
and repeated discard/retry cohorts retain all endpoint and observer-payload checks. PC execution
is ordinary non-quiet admission with sampled overlap records; the Mac uses fail-closed ownership,
AC and availability checks, then releases the lock between phases.

The canonical design note records the two-slot rejection: sixteen-terminal default dense CPU
+49%, scroll CPU +27%, and scroll JS heap +3.350 MiB for 6.0625 MiB less native memory. Its branch
is retained only as a reference. Worker revision publication and revision-based row patches are
separate successors, not part of this lane.

Receipts and mutation controls belong to
`/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step6/`. Qualification numbers are appended only
after the paired cohorts finish. CI owns the final full browser suite per coordinator instruction.

## Paired qualification

Common main base: `f6a409c29` (#44 merged). The deliberate all-clear before control is
`1d156c5bb`; the selective after application is `ea9718ff1`. Its production code is identical to
the common base; the after changes add only the regression and decision notes. Chromium is
153.0.8010.12, 200×50 at DPR 2. Timing uses 30 warmup and 180 measured iterations with two
counterbalanced pairs. The Mac uses a non-fallback M1 Metal adapter, AC and its exclusive lock.
The PC uses RTX 3060 Ti WebGL2/WebGPU under ordinary non-quiet admission. Twelve peer/server
records were sampled; these intervals are approximate and are retained in `pc-overlaps.json`.

All rows below are the repeated-discard stress case with sixteen terminals and observers on.
The line payload resets home before the discarded row; it is recovery stress, not normal scrolling.
CPU is renderer process milliseconds per iteration.

| Host/backend | Payload | CPU before → after | JS heap before → after MiB |
| ------------ | ------- | ------------------ | -------------------------- |
| PC webgl2    | dense   | 28.472 → 24.278    | 7.230 → 7.375              |
| PC webgl2    | line    | 9.778 → 2.444      | 6.927 → 5.500              |
| PC webgpu    | dense   | 29.694 → 25.139    | 6.552 → 7.260              |
| PC webgpu    | line    | 12.194 → 4.083     | 7.585 → 5.302              |
| Mac WebGPU   | dense   | 41.453 → 35.665    | 7.034 → 7.297              |
| Mac WebGPU   | line    | 16.874 → 6.082     | 8.771 → 5.436              |

Dense recovery CPU falls 14–15%; line recovery falls 64–75%. The largest recovery heap increase
is +0.708 MiB for PC WebGPU dense, within the +1 MiB bound; line recovery heap falls everywhere.
No normal Mac CPU regression exceeds repeat noise. The largest normal sixteen-terminal heap
increase is +0.012 MiB. PC WebGL2 dense without observers reads +3.6% amid peers; the matching Mac cell is
−0.5%. This is a non-quiet diagnostic finding, not an isolated timing claim, and is not chased.
The normal path never invokes either discard implementation.

All 84 pairs pass their endpoint checks: 60 timing pairs and 24 separately instrumented parity
pairs. Final text, cumulative text events, parsed writes and submissions match, as do every
observer payload hash in the parity cohorts. Normal sixteen-terminal timing parses and submits
2,880 writes/frames; recovery parses 5,760 writes and still submits 2,880 frames. Presentation
counts remain null, and energy is unmeasured. Mac source/dependency/download/profile payloads
and its lock are removed after the cohort. PC teardown and final CI state are reported in the PR.

Source gates pass 1,271 unit tests with one skipped, extension checks, typecheck, lint, formatting
and all seven docs checks. The new mutation guard fails with all-clear and passes with selective
invalidation. Ownership remains 50,000 retained bytes with release to zero; forced rollover and
independent-history tests remain green. GitHub CI owns the full browser suite on the final head.
