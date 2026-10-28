# Row-identity text revisions

Status: Approved production step 4, pending its hardware gate.

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
