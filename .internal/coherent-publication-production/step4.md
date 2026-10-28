# Row-identity text revisions

Status: Qualified production step 4. The coordinator owns review and merge.

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

## Observer-count investigation

The first non-quiet PC run stopped on cumulative DOM scroll text counts of 210 and 211.
The renderer's DOM path disables native retention, so it does not execute the changed revision
matcher. The original packet had no event-content trace and is retained unchanged.

The added trace records registration's frame boundary, every complete public text event and the
live viewport after every write. Twelve Mac trace arms each delivered all 210 written viewports
byte-for-byte, with every accepted frame delivered. Each also contained one initial blank event.

Three real-DOM tests drive the same 200×50 scroll payload through all 210 writes and check every
viewport and frame ID. Accepting the initial empty frame before registration produces 210 text
events. Accepting it after registration produces 211 events, with the extra event containing
only blank rows. Letting the first write replace the pending initial empty frame produces 210
events. All three cases deliver every written viewport and every accepted subscribed frame.

`docs/api.md` promises publication after every accepted frame while a listener is registered and
says registration starts with the next accepted frame. These startup cases satisfy that contract.
No product callback code or API promise changed. The harness now waits for initial acceptance
before registering measured observers, making startup deterministic. Count and full-payload
assertions remain strict. The shared workload function keeps the test and benchmark inputs equal.
Trace mode retains failing pairs before asserting; it makes no timing claim.

## Measurements

The measured application is `808a4f138bae98dd16821523d53fd141816df73b`. The before source is
`58a090d56`, whose only change from this branch's original main base is an unrelated design note.
Chromium is 153.0.8010.12. Hardware pairs use 200×50 at DPR 2, 30 warmup and 180 measured iterations,
with counterbalanced order and observers off/on at one and sixteen terminals.

At 16 terminals with observers on, the Mac's locked, AC-powered scroll renderer CPU falls from
13.674 to 10.011 ms/frame and heap falls 0.928 MiB. Dense CPU is 32.914 to 32.935 ms/frame, within
the 0.839 ms repeat spread, and heap rises 0.212 MiB. All Mac normal cells meet the gate. Its
observer-parity and repeated-discard cohorts pass; repeated-discard dense heap rises 0.238 MiB,
with CPU lower. Repeated-discard scroll CPU changes by 0.095 ms within its 0.445 ms repeat spread.

The completed non-quiet PC WebGPU dense cell at 16 observed terminals is 24.056 to 24.972 ms/frame,
up 3.8%. The coordinator accepted this as a finding under concurrent load, with the passing Mac
control. It is not an isolated timing claim, and it is not being chased on the PC. PC WebGL2 dense
is neutral; scroll CPU falls about 27% on WebGL2 and 26% on WebGPU. Recorded PC GPU 16-terminal heap changes
remain within +1 MiB. These measurements include the original startup control described above.
The startup correction changes harness initialization, not the measured production path.

The installed runner's `jobsDuringRun` is empty for this non-quiet run, although concurrent jobs
were observed. Its source creates overlap journals only for quiet runs. The raw record and
retrospective completed-job interval intersections are retained, with that limitation stated.
The earlier PC drain was terminated on the coordinator's instruction; its partial packet is
excluded from qualification. PC research now uses ordinary admission without quiet holds or
drains. Quiet timing belongs on the Mac or Pi. Presentation and energy remain unmeasured.

## Verification and receipts

The original software gate passed 32 focused tests, 1,216 unit tests and 1,174 browser tests.
There was one unit skip and five browser skips. Extension preparation preceded the browser suite.
The docs PTY round trip timed out once; one bounded rerun passed all seven checks. Both logs are
retained. The three new DOM contract cases pass on both hosts. Final PC gates pass 1,216 unit tests and
1,177 browser tests, with one unit skip and five browser skips, plus all seven docs checks. The
corrected PC harness passed six counterbalanced DOM scroll pairs with 210 events per arm. Each
complete event sequence equals the Mac trace after removing only its initial blank event; frame
IDs, full rows and row patches all match. `events/startup-equality.json` records that comparison.

Raw receipts belong to `/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step4/`, with event
contents, the initial blank payload and scheduler proofs under `events/`. Historical `HOLD.json`
records the earlier stop; this note incorporates the coordinator's later acceptance of the noisy
PC finding and the startup investigation. Ownership remains exactly 50,000 retained bytes and
releases to zero. The native counter rollover regression remains mandatory.
