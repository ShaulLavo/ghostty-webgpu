# Two native slots per subscriber

Status: Approved experiment, pending measurement. This is a new tradeoff, not an inherited KEEP.

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
