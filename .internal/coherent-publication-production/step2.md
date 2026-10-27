# Selective discard invalidation

Status: Approved, carried locally toward the cumulative step-3 gate.

Each pending capture owns its slot, token and set of revisions first inserted by its reads.
Discard removes those entries and that pending slot's revision list. It makes no native read or
wasm allocation. Accepted entries remain available, including after a partial read fails during
pruning. Current, previous and pending histories stay subscriber-local.

The failing-first cases populate accepted and pending caches, then discard normally or after an
insertion failure. They require the retry's previous rows to retain object identity with the
accepted rows and perform no native extraction. Both fail before the change and pass after it.
Existing different-output retry, overlapping subscriber, resize, disposal and acknowledgement
failure cases remain. Raw evidence is in
`/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step2/`.

The coordinator authorized carrying this step with step 3 before publishing a stack. The repeated
abandon/read/discard workload remains part of qualification; the cumulative normal-path gate is
checked against current main after step 3.
