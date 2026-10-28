# Selective discard final qualification

Status: Approved qualification, pending hardware gate. This lane step derives from merged #44
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
