# Revision-keyed worker publication research

Status: development checkpoint. No hardware screen or production rollout has been accepted.

Both arms use base `46399e3f0a3ce5f5ce216eb6fdf474822851c720`. This branch changes only the reviewed internal retained-frame accessor, dedicated-worker publication/reception, their tests and the paired research instrument. The native wasm, bridge, public APIs, acknowledgements, event order and three native slots are unchanged.

The publisher posts immutable full-cell structured-clone deltas synchronously. Reception commits a validated store epoch and one current revision pin atomically, restores deep frozen metadata ownership, and reconstructs eager summaries against the last host summary. There is no host release message or bounded outstanding queue. The publisher retains its last result and frame; each queued message owns its payload. The paced cohort does not qualify sustained-backlog memory.

## Development evidence

The real-wasm suite checks an eager live-row shadow, an independent never-pruning reference decoder, frozen ownership and current-pin bounds. It includes moved Unicode rows, equal-text cell edits, resizing, interleaved namespaces, discarded retry, delayed delivery, exact integer exhaustion and malformed packets. An initial sparse-array boundary defect was reproduced with two failing tests and fixed by validating every iterated entry, including holes.

All six temporary mutations of the actual candidate modules were detected and restored: disabled store invalidation, shared reception, never-pruned publisher history, no host pin, text-keyed content and a stale summary predecessor. The retained script and logs are in the external audit evidence directory. The wrong-predecessor mutation models the native-previous mistake by supplying the prior predecessor through the eager constructor; it does not claim that the host has a native token.

The rejected positional prototype is unchanged in behavior. Its local frame type is pinned to the historical full-frame shape so importing its research tests does not add a production compatibility branch.

## Instrument and qualification

`worker-revision-benchmark.ts` requires an explicit unchanged control root, checks the common base and scoped source difference, builds the same page/instrumentation against both roots, checks original fixture bytes, and records independent renderer submission counts. Per-frame hashing and held-output query probes run only in correctness mode. Timing uses the original PC thread-tick page endpoint, Linux dedicated-worker ticks and Chrome-family PSS plus VRAM growth. Presentation is unresolved.

The TypeScript analyzer has explicit CI discovery. Missing conditions, repetitions, steps, workers, submissions, CPU/PSS or actual headed hardware controls cannot yield KEEP. Headless output is correctness-only regardless of ratios. The unchanged fixed screen requires all eight conditions, two repetitions, eight warmups and sixty measured steps, followed by the original twelve-condition cohort only on pass. Every numerical gate remains unchanged.

## Pending

Finish development checks and actual unchanged-control parity, then acquire an available quiet hardware slot with a task-owned display/browser. No source-based speedup is claimed. A valid failed screen closes this candidate; setup failures do not consume a screen.

External reports and receipts belong to `/work/reports/wave-20261106/audits2/ghostty-webgpu/007-evidence/`. The coordinator owns the read-only control and its retained dependencies until this task releases that consumer. T3 owns this candidate worktree. Shared caches are not cleanup targets.
