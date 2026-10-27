# Multiple render states review corrections

Status: Approved. PR #9 review at `b246eea939c6325b68efcd3fa1525af0d2762473`.

The review found two distinct consumption boundaries. `ZigFrameBuilder.ensureActive()`
called the subscriber's preparation callback on getters and glyph-cache operations. Those
operations only access already-built records, so they must not observe a newer native
snapshot. Preparation belongs in `build()`; lifetime validation stays on every operation.

WebGPU's coordinated path captured retained text inside deferred `commit()`. Another
subscriber could replace the shared native viewport after command encoding, so that capture
published newer text than the command's pixels. Retained text and an acknowledgement bound
to the consumed version must be staged during encoding and accepted or discarded at submission.
The acknowledgement also stays bound when another read of the same subscriber occurs before
commit. Named public methods and their signatures remain stable for the X7 dependent lane.

The review tests cover six cached-builder operations and two deferred-commit interleavings.
The browser cases compare the committed pixels to an independently submitted reference and
check the retained text, pending newer damage and subsequent catch-up frame.

Main is integrated with a merge commit, without rebase or force-push. PR #11's bridge-based
native clean replaces only shared native acknowledgement. B1's per-consumer version filtering,
damage distribution, preparation invalidation, scalar storage and iterator helpers remain.

Before setup, the original B1 worktree had already been removed. Existing wave worktrees,
services, caches, heavy jobs and review evidence under `rv9/` belong to their current owners.
This correction owns `/work/worktrees/ghostty-webgpu/b1-review`, its dependencies, dist,
Vitest screenshots and heavy-runner jobs. Vitest and the runner tear down their children on
exit. No dev server, deployment, upstream checkout or headed browser is created. The task
worktree and task scratch files are removed after pushing and posting the review reply.
Small logs and screenshots in `/work/reports/ghostty-webgpu-next-2026-10/b1-review/` remain
for coordinator review and can be removed after the corrected PR merges.

Initial reproductions failed at the expected boundaries. All six cached getter/glyph cases
returned one acknowledged row instead of zero. Both deferred browser cases kept the expected
encoded pixels but published `NEW before` instead of `old before`.

After integrating native clean, acknowledgement and retained-frame/hold tests passed 26 cases.
After separating preparation from builder validation, the acknowledgement, multi-state and
Zig frame tests passed 127 cases. Version-bound acknowledgement tests cover both one and two
subscriptions, including a later read before commit. They also assert dispatch through the
public acknowledgement method, which existing tests and benchmarks decorate. The bound
version has a synchronous scope that restores its previous value even on an exception.

The deferred path uses an internal symbol to capture acknowledgement without changing named
public methods or their signatures. It stages `PreparedFrame` before coordinator submission,
accepts it only on successful commit, and discards it on submission failure or disposal.
The browser regressions also inject one failed queue submission and verify retry without
publishing the discarded retained frame or clearing its damage.

## Final verification

- `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check` passed on
  the PC. Lint reports existing warnings outside this change.
- `bun run test:unit` passed on the final source after the recovery correction: 1,129 Vitest
  tests, one existing skip; 482 comparison tests and four checkpoint tests passed.
- The first seven-file Chromium run passed 51 cases and exposed three existing capture-recovery
  assertions after moving capture earlier. Staging failures now use the same bounded retry
  handler as deferred submission failures. No existing assertions were weakened.
- `bun run test:browser src/render/tests/deferred-render-state.browser.test.ts src/dom/tests/displayed-frame-boundaries.browser.test.ts src/dom/tests/zig-frame.browser.test.ts src/render/tests/webgpu.browser.test.ts`
  passed all 37 cases on the final source. This includes the reviewed races, injected queue
  failure, public acknowledgement instrumentation, staging/acceptance failure recovery, and
  bounded retries. The other 17 cases in the earlier run covered multi-state pairs and
  synchronized/held main and worker rendering and all passed.
- `bun run --cwd site docs:check` passed, including 17 authored pages and seven tests.
- Chromium on the PC used headless SwiftShader for correctness. Both saved deferred-frame
  screenshots were inspected at original resolution and show `old before`, matching the
  encoded reference pixels while newer native text remains pending.

The PC queue was busy while the Mac became available. A task-owned source copy and atomic Mac
lock were prepared as a fallback. The PC then completed, so the duplicate Mac run was canceled.
Its unit/static/docs gates and all native browser cases completed successfully before exit.
The Mac source copy, dependencies, temporary browser data and lock were removed and checked
absent. Shared package/browser caches were preserved. The PC transfer archive was removed too.

## Mac control finding

An unrelated xterm comparison control produced one extra `onRender` callback on the Mac in the
seven-file run. An isolated second attempt passed, so this is a transient control frame-count
failure, not a reproduced native-terminal regression. No production or test changes were made
for it. The native terminal changes do not run in the isolated xterm control.

Source under test matches production commit `e639f10a66f04ddd6f75d3fb3b4a8999a5dfefd7`.
Host was the M1 Mac, Bun 1.4.4, Playwright 1.63 Chromium, with the repository's default browser
configuration. Reproduce in an exclusive checkout with `bun install --frozen-lockfile`,
`bun run build`, then `bun run test:browser src/render/tests/held-output.browser.test.ts`.
The first cohort also ran the six other browser files listed in `final-gates.log`.
Observed at `src/render/tests/held-output.browser.test.ts:299`: expected released frame count
`normal.frames + 1` = 2, received 3; pixel checks had passed. The isolated command
`bun run test:browser src/render/tests/held-output.browser.test.ts -t xterm` passed one case,
with the two native cases skipped. Logs are `mac-gates.log` and `mac-xterm-control.log` under
`/work/reports/ghostty-webgpu-next-2026-10/b1-review/`. A follow-up should inspect the xterm
fixture's `terminal.onRender` count and its initial/release refresh timing before changing
this exact-count assertion. The PC cohort passed this control.
