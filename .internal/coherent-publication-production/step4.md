# Row-identity text revisions

Status: Approved implementation. STOP: step 4 has not passed qualification; no PR opened.

After the first retained text read, dirty captures record upstream row IDs. A revision is reused
only when an accepted baseline row has that ID and its native cells and graphemes match, ignoring
style bits. Newly observed histories need an observed baseline before moved rows can match.
Captures without text demand avoid the identity lookup and comparison.

The cache repositions an immutable row without copying its owned cells. Rows remain local to
one subscriber. Pending attempts still record only entries they insert, so discard preserves
accepted entries. Native revisions retain the u64 counter and exact-JS exhaustion check.

The failing-first test scrolls two rows and observes eight extracted rows on main. The new path
requires two. Additional cases cover same-ID edits, changed combining sequences, styled rewrites,
complete cell and continuation output, and a populated moved-row attempt followed by discard
and a different retry. Existing independent-history, failed-capture, acknowledgement, ownership
and rollover tests remain gates. The retirement check counts distinct rows across readable
histories because those histories can now share revisions.

Qualification receipts belong to
`/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step4/`. No new hardware claim is made until the
same-session PC and Mac pairs pass. The repeated discard/retry cohort remains separate from
normal scroll, and presentation and energy are reported only if measured by the instrument.

## Qualification hold

Application source: `808a4f138bae98dd16821523d53fd141816df73b`. The before source is
`58a090d56`, whose only change from this branch's original main base is an unrelated design note.
All runtime and benchmark control inputs match that base.

The local gates passed 32 focused tests, 1,216 unit tests and 1,174 browser tests. There was one
unit skip and five browser skips. Extension preparation preceded the browser suite. The docs PTY
round trip timed out once; one bounded rerun passed all seven checks. Both logs are retained.

The Mac's locked, AC-powered pairs pass. At 16 terminals with observers on, scroll renderer CPU
falls from 13.674 to 10.011 ms/frame and heap falls 0.928 MiB. Dense CPU is 32.914 to 32.935
ms/frame, within the 0.839 ms repeat spread, and heap rises 0.212 MiB. Its complete observer-parity
and repeated-discard cohorts pass.

The replacement PC run used ordinary non-quiet admission. Its completed WebGPU dense cell at
16 observed terminals is 24.056 to 24.972 ms/frame, up 3.8%, against only 0.056 ms of repeat
spread. This fails the stated per-step noise gate. PC WebGL2 dense is neutral, and scroll CPU
falls about 27% on WebGL2 and 26% on WebGPU. These are process-CPU diagnostics under concurrent
jobs, not isolated timing or energy results.

The PC run then exited on DOM scroll at one observed terminal: cumulative text events were
210 versus 211. Parsed writes and submitted frames are both 180, and final text hashes match.
The event field includes startup and warmup. The cause of the mismatch is not established;
its assertion remains intact. PC parity and repeated-discard cohorts were not reached.

The installed runner's `jobsDuringRun` is empty for this non-quiet run, although concurrent jobs
were observed. Its source creates overlap journals only for quiet runs. The raw record and
retrospective completed-job interval intersections are retained, with that limitation stated.
The earlier PC drain was terminated on the coordinator's instruction; no request, lock or child
remains. Its partial packet is excluded from qualification. Future PC research uses no quiet
admission or drain; quiet timing belongs on the Mac or Pi.

## Owner decisions

Step 4 stays local because the CPU and observer-count gates have not passed. Steps 5 and 6 have
not started. A successor needs to investigate the dense CPU result and the DOM event mismatch,
and provide overlap observations for non-quiet PC runs before claiming qualification. No
comparison was weakened and no failing packet was discarded. Raw evidence and reproduction
commands are in the report directory above, especially `HOLD.json`, `pc.log`, `pc-failed-pair.json`,
`pc-runner.json`, `pc-derived-overlaps.json`, the three Mac packets, and `full.log`.
