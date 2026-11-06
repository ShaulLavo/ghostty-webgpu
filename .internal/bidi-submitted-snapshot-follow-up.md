# Own BiDi selection in submitted full-frame snapshots

Status: Approved, queued correctness follow-up. This is separate from the rejected revision-publication optimization and the held-output selection fix. Do not import the rejected transport or its new accessors to close it.

## Confirmed problem

On production base `46399e3f0a3ce5f5ce216eb6fdf474822851c720`, a BiDi visual drag on `ab שלום cd` from column 3 to column 1 paints logical cells `[1, 2, 6]`. After that frame is submitted, clearing selection without submitting a newer frame makes the live-wrapper `frameSnapshot()` return native logical cells `[1, 2, 3, 4, 5, 6]`. That is neither the last painted visual mask nor the newly cleared state.

The independent real-Wasm probe reproduced this on the base and research checkpoint `2082c6c0534f3289e9970945624c54f281413fb4`. Source ownership is `LocalTerminalExecution.frameSnapshot` in `src/dom/execution-local.ts`, the BiDi `TerminalSession.renderState` wrapper in `src/term/session.ts`, and `BidiSelectionGesture.selectedRows` in `src/bidi/selection.ts`. Snapshot-version equality alone does not freeze JavaScript selection state. The superficially similar captureViewport query rejects the changed session revision correctly and is NOT a confirmed bug.

## Reproduction record

The ready-to-run owner-machine probe and logs are retained at:

- `/work/reports/wave-20261106/audits2/ghostty-webgpu/ADDENDUM007-BIDI-probe.ts`
- `ADDENDUM007-BIDI-probe-base.log` and `ADDENDUM007-BIDI-probe-checkpoint.log` beside it.
- `ADDENDUM007-BIDI-REVIEW.md`, section F2 and its separate frameSnapshot result.
- `007-bidi-ownership-observation.md` in the same report directory.

Run the probe with `bidi-js` 1.0.3 available and an exclusive checkout at the base:

```sh
bun /work/reports/wave-20261106/audits2/ghostty-webgpu/ADDENDUM007-BIDI-probe.ts "$PWD"
```

The `viewportWindow` collection creates a real BiDi session and local execution, submits the disjoint drag, clears selection before another submission, and records both full-frame selection and the correctly rejected captureViewport query. Use that sequence to add a discovered regression with literal columns, not only equality between two new helpers.

## Execution

1. Recheck current main and reproduce the between-publication mismatch without the experimental transport. Keep the separate held-output fix intact.
2. Have the tech lead choose the smallest ownership correction for main and worker full-frame reads. Compare a cheap captured selection projection against native retention; do not assume the rejected candidate's three-slot adoption is the only answer. Independent design review precedes a new shared frame-ownership contract.
3. State the public snapshot contract explicitly. Preserve last-submitted text, cell boundaries, styles and selection together. Do not silently return an incoherent mix, or change availability semantics with a guard without checking that contract.
4. Test selection mutation before publication, held output, clear and programmatic ranges, wide tails, scroll/reflow, discard/retry, actual GPU and Canvas/DOM policies, main/worker requests and disposal. Keep independent literal/pixel oracles and no live pin borrowing by a submitted snapshot.
5. Measure ownership cost where it changes. The rejected research seam would lazily add three native slots for main-GPU BiDi, roughly 843,600 bytes at 200 by 50 before graphemes/readers/allocator/JS overhead. Its active masks retain history coordinates, not only visible cells. Canvas and DOM did not gain that retention. These are cost disclosures, not a complete measured bound or an automatic implementation approval.
6. Land the selected correctness fix through independent code review, green CI, confirmed merge and the normal patch release. No public API, WASM fork, worker pool, version-skew fallback or change to captureViewport is implied.

## Why this is separate

Audit 007's qualified fixed hardware screen rejected the combined publication candidate in every host-time condition and also found CPU, memory and tail regressions. Its transport, revision accessor and retained-selection implementation stay on the research branch. Reusing that entire implementation as an unmeasured correctness fix would evade the decision. This follow-up preserves the confirmed problem and executable evidence while requiring an independently scoped ownership solution.
