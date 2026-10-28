# Two native slots per subscriber

Status: REJECTED by the coordinator on 2026-10-28. Keep three native slots in production.

A subscriber's text history has a native, owned or retired state. Before a previous native slot
becomes the next capture target, its unread rows are materialized and its ordered revisions are
pinned. The current native slot remains untouched. Acceptance retires the oldest history and
releases its pins. Discard retains accepted current paint and owned previous text while reusing
the scratch slot for another attempt. Failed allocation or capture exposes no new frame.

A mismatched scratch slot is freed after its previous text is owned and before replacement
allocation. The steady and replacement paths therefore hold at most two native cell arrays.
Each capture still receives a fresh descriptor because handles are recycled. Histories, caches
and pending-entry ledgers stay subscriber-local. No packet compaction or shared-current store is
introduced. The native text counter and exact-JS exhaustion boundary are unchanged.

The failing-first allocation test submits six frames without text reads. Main peaks at three
native slots; this implementation requires two, then checks lazy current and previous text and
releases both allocations at disposal. Additional coverage holds unread previous text across
capture failure, populated pending discard, resize, stale-token retirement and owned-row use.
The historical independent-history, unequal-cadence, partial-capture, ownership and rollover
regressions remain mandatory. The rollover fixture follows the new history object to the same
native counter offset; its forced boundaries and assertions are unchanged.

Materializing previously unread text adds JS work and rows on the no-observer path. That cost
must be measured against native memory removed; it is not treated as free work. Source receipts,
failing-first output and hardware packets belong to
`/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step5/`. The gate retains all observer payloads,
selection, accessibility, links, DEC 2026 holds, displayed capture and worker publication.

## Rejection

The AC-powered, locked M1 Mac run compares the three-slot parent
`a5840a57d7d0de0e4a58106ad0bd87f67281a667` with application checkpoint
`c5e3b39923a874de36d7121661a058747c786dff`. Chromium 153.0.8010.12 uses a non-fallback Metal
adapter, 200×50 at DPR 2, 30 warmup and 180 measured iterations, two counterbalanced pairs.
At sixteen terminals without text observers, dense renderer CPU rises 22.787 to 33.942 ms/frame
(+49.0%) and scroll rises 6.113 to 7.744 ms/frame (+26.7%). Scroll JS heap rises 3.350 MiB.
Wasm memory falls 6.0625 MiB, but that saving does not justify the default-path CPU and heap cost.
Observed dense is 1.1% lower and observed scroll 9.2% lower; those gains do not rescue the default.
All output/parity and repeated-discard pairs match. Lifetime, ownership and rollover checks pass.

This branch is retained only as a rejected reference checkpoint. It must not be merged into
production. Selective discard invalidation remains on the three-slot path and does not depend on
this experiment. Worker revision publication is a separate successor outside this lane.
