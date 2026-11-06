# Revision-keyed worker publication research

Status: research checkpoint awaiting a reviewed BiDi retention ownership correction. No hardware screen has started. This candidate is not ready for production.

Both arms use base `46399e3f0a3ce5f5ce216eb6fdf474822851c720`. This branch changes only the reviewed internal retained-frame accessor, dedicated-worker publication/reception, their tests and the paired research instrument. The native wasm, bridge, public APIs, acknowledgements, event order and three native slots are unchanged.

The publisher posts immutable full-cell structured-clone deltas synchronously. Reception commits a validated store epoch and one current revision pin atomically, restores deep frozen metadata ownership, and reconstructs eager summaries against the last host summary. There is no host release message or bounded outstanding queue. The publisher retains its last result and frame; each queued message owns its payload. The paced cohort does not qualify sustained-backlog memory.

## Development evidence

The real-wasm suite checks an eager live-row shadow, an independent never-pruning reference decoder, frozen ownership and current-pin bounds. It includes moved Unicode rows, equal-text cell edits, resizing, interleaved namespaces, discarded retry, delayed delivery, exact integer exhaustion and malformed packets. An initial sparse-array boundary defect was reproduced with two failing tests and fixed by validating every iterated entry, including holes.

All six temporary mutations of the actual candidate modules were detected and restored: disabled store invalidation, shared reception, never-pruned publisher history, no host pin, text-keyed content and a stale summary predecessor. The retained script and logs are in the external audit evidence directory. The wrong-predecessor mutation models the native-previous mistake by supplying the prior predecessor through the eager constructor; it does not claim that the host has a native token.

The rejected positional prototype is unchanged in behavior. Its local frame type is pinned to the historical full-frame shape so importing its research tests does not add a production compatibility branch.

## Instrument and qualification

`worker-revision-benchmark.ts` requires an explicit unchanged control root, checks the common base and scoped source difference, builds the same page/instrumentation against both roots, checks original fixture bytes, and records independent renderer submission counts. Per-frame hashing and held-output query probes run only in correctness mode. Timing uses the original PC thread-tick page endpoint, Linux dedicated-worker ticks and Chrome-family PSS plus VRAM growth. Presentation is unresolved.

The TypeScript analyzer has explicit CI discovery. Missing conditions, repetitions, steps, workers, submissions, CPU/PSS or actual headed hardware controls cannot yield KEEP. Headless output is correctness-only regardless of ratios. The unchanged fixed screen requires all eight conditions, two repetitions, eight warmups and sixty measured steps, followed by the original twelve-condition cohort only on pass. Every numerical gate remains unchanged.

## Correctness result and required design correction

The full eight-condition headless comparison passed against the unchanged worker control. It includes every delivered projection, summary and host-state sequence, complete final snapshots, held-output query probes, text, decoded pixels, native events, inputs and counts. Independent submissions were measured, not copied from delivery. The result is correctness-only.

The single full verification run found a real integration gap. All sixteen worker BiDi interaction cases fail because the session's BiDi selection wrapper does not expose retained native frames. A forwarding-only change would also affect the main-entry retained branch and could lose the captured selection overlay in full-frame queries. The coordinator is obtaining a narrow ownership-design correction and independent review. No seam or full-frame fallback is implemented here, and no hardware screen may run before this is resolved.

The new failing real-wasm test first proves a disjoint visual selection at logical columns 1, 2 and 6, then requires the retained projection to survive selection clearing. The current failure is the missing retention function. This test stays failing on the research branch deliberately. It is not a knowingly failing product PR.

The full gate otherwise passed 1,647 unit tests and 1,408 browser tests before a separate Vite iframe initialization/reload error interrupted completion. That affected file passed both tests in one bounded isolated rerun. This does not turn the full gate green or establish the Vite error's cause. The six real mutations, including a stale predecessor that fails specifically on clean resubmission, were detected and restored. Typecheck, lint and formatting pass.

The runner's owned hardware-display path is implemented and statically checked, but has not run a screen. The supplied hardware preflight is capability evidence only. No timing win or rejection is claimed.

External reports and receipts belong to `/work/reports/wave-20261106/audits2/ghostty-webgpu/007-evidence/`. The coordinator owns the read-only control and its retained dependencies until this task releases that consumer. T3 owns this candidate worktree. Shared caches are not cleanup targets.

## Reviewed BiDi continuation

The coordinator reconciled the independent BiDi addendum review. The stable session source now forwards retention through a capture-time selection wrapper. Its private overlay owns numeric row/column sets, never pins or a live gesture. Native tokens, text revisions, source identity and retirement pass through unchanged. No mask returns the original native frame without row extraction. An empty mask still wraps and clears stale native bits. Capture cost is O(mask pins), and retained coordinates include pins below the viewport; this is not a visible-cell bound.

Main GPU BiDi now enters the same lazy three-native-slot retained path as main GPU without BiDi. Canvas and DOM keep their existing owned-row policy. Active-selection memory is outside the unselected performance cohort. The held-offset F1 behavior is deliberately unchanged and separately owned; F2 was not reproduced and is not patched.

The real-Wasm tests use an independent copy of the checkpoint membership formula over raw native rows, copied pin coordinates and copied offset. Literal disjoint columns, nonzero-offset rows and wide lead/tail bits prevent shared helper code from proving itself. A held fixture first proves an empty visible mask alongside stale selected native bits, then requires the empty overlay to clear them. Wrapped/plain/wrapped publication and clean resubmission keep epoch 1 and agree with both eager shadow and reference decoder.

Actual mutations were detected for forwarding without overlay, live pin borrowing, offset zero, missing continuation propagation, skipping empty wrapper creation, skipping empty decoration and fresh wrapper store identity. Live borrowing failed both held-token stability and the post-capture pin-call spy. Forward-only also failed the explicit main-GPU browser case. The original six transport mutations were rerun and detected. Every mutation was restored.

All 24 original BiDi browser cases remain. New genuine pointer/pixel coverage asserts logical `[1, 2, 6]` against independently painted visual `[1, 2, 3]`, explicitly proves main-GPU backend and native token, and checks clear selection only on a later accepted frame. The held-only test uses normal selection commands with the optional expected identity omitted, on both Canvas reference and workers. It checks accepted native selection, unchanged held text and released snapshot/pixels. It is command-level publication coverage, not a claim about DOM pointer behavior during hold. No DOM guard or transport bypass was added.

Focused real-Wasm and lazy tests passed 70 cases. All 32 BiDi interaction browser cases passed after the bounded held-test stimulus correction. Full verification and hardware qualification remain the next gates. The earlier failure records above are preserved history, not current failures of the implemented seam.
