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

## Intermediate gate

The coordinator accepted a bounded intermediate cost on 2026-10-27. The standalone cache step raised normal-publication
heap use on the Mac. At sixteen observed terminals, scroll JS heap rose from 7.99 to 8.67 MiB;
wasm stayed 120.19 MiB. Dense heap rose from 7.15 to 7.40 MiB and wasm stayed 120.25 MiB.
Scroll renderer CPU was 18.62 to 18.21 ms per loop and dense CPU 36.76 to 37.13 ms.
These are experimental medians of two counterbalanced pairs, not precise regression estimates.

The approved note's combined prototype has normal scroll CPU 17.81 to 10.24 ms on the Mac
and two MiB lower wasm at sixteen terminals. This first step alone does not reproduce that
result. It retains the observer cache and gives dirty rows fresh revisions, so normal publication
still extracts previous text and adds the revision map. An instrumented parity run that forces
native current and previous reads does save two MiB, illustrating why that run cannot stand in
for normal publication.

Before was `31c493e8650cfdee551701f9e32602680b3267dc`; after was
`2c6c62db73af3a4fcaffa9db9a79e606a87e8506`. The Mac used Chromium 153.0.8010.12,
Apple M1 Metal, AC power and its agent lock. The harness used 200×50, DPR 2, one and sixteen
terminals, dense and scroll, observers off and on, 180 steps after thirty warmup steps, two
counterbalanced pairs per cell. All sixteen normal pairs had equal final text, parsed writes,
text callback counts and submitted frames. All eight separate parity pairs also had equal
observer digests. Parity used twenty-four steps after six warmup steps and one pair per cell.
No presentation count or pixel-parity qualification is claimed.

The coordinator set the per-step gate to equal output for every observer, no normal-path CPU
regression beyond pair noise, and at most one MiB additional JS heap at sixteen observed
terminals against the main baseline. The Mac scroll increase of about 0.68 MiB passes that
intermediate heap gate. Record that transient cost in this step's PR.

The cumulative gate is due at the end of step 3: JS heap must be at or below the main baseline,
and normal scroll and dense CPU must both improve at sixteen terminals. Stop and report if
that gate fails. The full prototype's KEEP decision remains intact.

The first run stopped before push while this gate was unresolved. PC pairs and the full browser
suite were cancelled before starting. Work resumes from local checkpoint
`febbe20217f6e76b9af2572966f0b8d6598a4de2` with the coordinator's explicit gate.

Verification already completed: expected red test on main, native build against pinned upstream
with Zig 0.16.0, twenty-one focused real-wasm tests green, and the Mac hardware pairs above.
Full qualification results follow after the resumed run finishes.

## Cache lifetime repair

The first PC matrix had one noisy dense WebGPU heap cell above the intermediate limit:
+1.27 MiB. A bounded two-pair confirmation measured +0.62 MiB. Both packets remain in the
raw evidence. Inspection then found a cache-lifetime gap: after the third eagerly read capture
was accepted, the map still held twelve rows on a four-row grid, even though only eight rows
belonged to readable native slots. Pruning had waited for the next text read.

The failing-first lifetime test now requires retirement at acceptance. Each capture has a distinct
JS descriptor, even when it reuses a native slot. Cache reads remember that descriptor's ordered
revisions. Acceptance removes retired entries using those known revisions, without a bridge read
or wasm allocation. Owned rows stay valid after eviction and disposal. Native capture and token
lifetimes remain subscriber-local. This is cache lifetime bookkeeping, with no packet compaction
and no conditional cache of materialized paint rows.

The archaeology ledger's A55, A56, A57 and X7 mapping were read before the next production step.
The existing displayed-frame, incremental-displayed-frame, multiple-render-states and failure-boundary
cases descend from A55 and remain in qualification. A57's progressive-packet and held-row probes
are controls for later owner changes, not approval to restore its rejected compaction algorithm.
