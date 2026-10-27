# Multiple render states on one terminal

Status: Approved. Finding B1 in the October reference study next-steps plan.

## Consumer trace and impact

The built-in product does not create two render states for one terminal. `src/term/session.ts`
creates one terminal and one render state per session. Both the page execution in
`src/dom/execution-local.ts` and `src/worker/runtime.ts` use that session implementation.
The worker host projects submitted frames rather than owning a second native terminal or
render state. Accessibility, frame observers and extensions consume those submitted frames.
Renderer replacement reuses the session's state. Benchmarks, correctness scripts and the
classic site's initial-frame generator each create one state for their own terminal.
A search of Fregat's checked-in source found no additional `createRenderState` call sites.

The public `GhosttyRuntime.createRenderState(terminal)` API does permit multiple consumers.
A caller attaching two independent renderers would see one viewport stop receiving changed
text while its cursor still follows the native terminal. There is no existing built-in
multi-state consumer to regress in a browser. The new browser test exercises that supported
public composition directly with two independently scheduled instances of each renderer.

## Cause and chosen ownership

At the official pin `7b11f3dca034d8d24369ad3856afe57946d7902a`,
`src/terminal/c/render.zig:278` delegates update to the native render state.
`src/terminal/render.zig:510` documents that updating consumes terminal damage. Its page and
row traversal clears source damage, and the update clears terminal and screen dirty flags.
A second native snapshot therefore misses incremental changes to an unchanged viewport.
The C API's state and row dirty setters clear renderer acknowledgement flags; they do not
restore source terminal damage. This reproduces without DEC 2026.

The bridge uses those public C API row iterators and flags for row extraction and Zig frame
construction. It forwards the native hold callback synchronously into `GhosttyTerminal`.
Nothing in the bridge duplicates terminal damage for independent native snapshots.

The chosen data shape is one `SharedRenderState` per terminal, with one public
`GhosttyRenderState` subscription per consumer. Every subscription reads the same latest
captured viewport and cursor. With multiple subscriptions, pending rows carry their last
changed snapshot version. Each subscriber also tracks the last version it updated or read.
Acknowledgement removes only that subscriber's observed damage. A newer capture stays pending,
even if the same row changed again before acknowledgement. Full damage replaces obsolete row
indices after resize. Before native reads or frame building, the subscription's pending flags
are applied through the public C API. Repeated reads by the same subscriber reuse those flags.

Native damage is cleared before the next shared capture, then the newly consumed damage is
copied to every subscriber. The ordinary single-state path keeps native damage directly and
allocates no per-row subscription map. The hold callback captures the baseline exactly once.
A subscriber created during a hold can read that shared safe baseline; without an existing
snapshot it waits for release. Submitted-frame stores remain separate per subscription.
Disposing the last subscription releases the native snapshot and its hold listener.

Rejected alternatives were forcing full rebuilds through overscan changes, which depends on
an implementation detail, and tracking every terminal mutation in JavaScript, which duplicates
the upstream damage model and must handle writes that capture holds mid-parse. No core or bridge
wasm, upstream source, package version or compatibility code changed.

The Model the Domain principle led to shared snapshot ownership and versioned pending rows.
Fix Root Causes kept the correction at the native-damage consumer rather than in renderers or
hold branches. Prove It Works led to real-WASM Node regressions and browser pixel checks.

## Verification and resources

Throughput checkpoint: one core implementation file, one Node regression file, one existing
retention-test helper update, one four-backend browser regression, and API documentation.

Before setup, the shared checkout, other wave worktrees, shared caches, gallery service and
heavy-runner jobs already existed. This task owns its B1 worktree and installed dependencies,
dist output, Vitest screenshots and queued/executing heavy-runner children. No server,
deployment, reference checkout, native build or headed browser was created. The heavy runner
and Vitest own process teardown. The worktree is removed after push and PR creation. Small
logs and screenshots remain in `/work/reports/ghostty-webgpu-next-2026-10/b1/` for review.

Failing-first Node output against the real checked-in wasm:

```text
Test Files  1 failed (1)
     Tests  4 failed (4)
Expected: "old before"
Received: "old"
Expected: "new"
Received: "old"
```

The focused fixed run passed 17 tests across the new regression, synchronized-output and
render-state files. The first full run passed build, typecheck, lint and formatting. Its
1,114 executed unit tests exposed two retention tests inspecting native handles on the old
private owner. The helper now reads the shared owner. A new regression verifies separate
submitted-frame histories without inspecting internals. The missed-row assertion includes
the old cursor row because native cursor movement also damages that row.

Direct investigation, design comparison, implementation and comment review replace playbook
delegation because the binding lane brief forbids starting other agents. Repository Node and
Chromium workflows replace the unrelated Fregat verification skill. The coordinator owns
independent review, CI and merge; this lane stops after opening its PR.

Final gates passed on the PC through the shared heavy runner:

- `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`.
  Lint reports existing warnings outside this change.
- `bun run test:unit`: 1,115 Vitest tests passed, one existing skip; 482 comparison tests
  and four checkpoint tests passed.
- `bun run test:browser src/render/tests/multiple-render-states.browser.test.ts src/render/tests/synchronized-output.browser.test.ts src/render/tests/held-output.browser.test.ts`:
  all 17 tests passed. The new tests cover Canvas, DOM, WebGL2 and WebGPU pairs; existing
  regressions cover held host and worker rendering. Headless Chromium with SwiftShader proves
  correctness only. Pair screenshots are equal after release and unchanged during holds.
- `bun run --cwd site docs:check`: examples compile, 17 authored pages checked, seven Bun tests
  passed.
- Original-resolution review of all four backend screenshots confirms the released
  `partial complete` text. Both images of each pair are pixel-identical by test assertion.
- `git diff --check` passed. The checked-in core and bridge wasm are unchanged.

Logs and eight screenshots occupy 108 KiB in the report directory. They are review evidence,
owned by this B1 report and removable after the coordinator finishes review and merges the PR.
The initial queued suite repro was canceled before execution and replaced by a small Node
job. A later queued gate was canceled before execution to include a final rebuild. No duplicate
job was left running.
