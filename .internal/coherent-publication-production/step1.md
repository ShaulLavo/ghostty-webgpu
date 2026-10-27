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

## Measurement stop

Do not push this step yet. On 2026-10-27 the standalone cache step raised normal-publication
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

Owner decisions: retain separate PRs with an explicit intermediate memory allowance, then apply
the full normal-path gate after the identity step; or change the production step boundaries.
The KEEP decision for the full prototype remains intact. The user requires a stop when a step's
measurement conflicts with the note, so the pending PC pairs and full gates were cancelled before
starting. No branch was pushed, no PR opened and no later step started.

Verification completed: the expected red test on main; `bun run build:wasm` against the pinned
upstream with Zig 0.16.0; twenty-one focused real-wasm tests green. An early typecheck ran before
`dist` existed and failed on missing built entry points. Build, final static checks, full unit
suite, extension preparation and full browser qualification remain unrun. This commit is a
reviewable checkpoint, not a completed production migration.
