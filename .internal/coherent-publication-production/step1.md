# Failure-safe displayed text cache

Status: Approved. Production step 1 of the [migration](../coherent-publication.md#production-migration).

Each subscriber keeps its own native current, previous and pending frames and a map from native
text revision to an owned text row. Only revisions in readable slots remain cached. Dirty rows
receive new revisions; row-identity matching belongs to step 4. The current and previous reads
share one native reader instead of maintaining a separate previous-frame scratch allocation.
Discard clears this subscriber's cache before the accepted baseline can issue those revisions
again. Selective invalidation belongs to step 2. Observer extraction stays unchanged until step 3.

The new real-wasm test first fails on main because reading the next frame's previous rows makes
two native text calls. It expects zero calls and unchanged rows to retain object identity. Other
cases cover dense writes, scrolling, Unicode, style changes, resize, populated pending discard,
different retry content, overlapping subscribers, unequal cadence, disposal and acknowledgement
failure after an eager pending read. Existing capture and extraction failure tests remain.

Raw evidence: `/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step1/`.
