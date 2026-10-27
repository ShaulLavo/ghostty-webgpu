# DEC 2026 hold

Status: Approved

The native render-hold callback captures each existing render state synchronously before parsing continues. Each terminal owns a one-second deadline. Render states retain their captured native snapshot during the hold. Renderers subscribe to snapshot requests so timeout release paints without another write. Native reads remain live; frame observers and accessibility continue reading submitted frames.

Polling mode after a write loses the pre-hold snapshot. Blocking only the scheduler also loses completed frames between consecutive holds. Capturing in the callback follows the upstream contract and works across all renderers and worker execution.

Throughput checkpoint: one core change shared by all backends, one Node regression file, one browser matrix of six backend/entry combinations. No upstream patch or renderer rewrite.

Before setup, existing resources were the shared checkout, two unrelated study worktrees and existing heavy jobs. This run owns the dec2026-hold worktree, one detached pinned-source worktree, installed worktree dependencies, dist, browser test screenshots and heavy-run child processes. The heavy wrapper and Vitest own process teardown. Remove both task worktrees after push; keep this small receipt and regression tests in the PR. No dev server or deployment is created.

Initial real-WASM regression: 5 tests failed. Expected "old frame", received "partial". Consecutive hold expected "first", received "second". Timeout/reset/resize setup expected "old", received "new".

Browser baseline after fixing test geometry: all six cases failed with expected "before", received "partial". The first attempt used auto-fit and four main-entry cases raced the initial fit; the fixed-grid rerun reproduced the hold bug on all six.

First fixed run passed all 309 core/provenance tests, build/typecheck/lint/format and docs checks. Browser checks exposed a Canvas source adapter that omitted the new wake subscription; forwarding it fixes timeout painting. Worker renderers may legitimately repaint the captured baseline, so observer assertions inspect submitted text and pixels rather than requiring no redundant frame event. DOM/WebGL/WebGPU and the existing held-clock tests already passed.

Final verification:

- `bun run build` passed after the Canvas forwarding fix.
- `bun run typecheck`, `bun run lint`, `bun run format:check` passed. Lint printed existing warnings outside this change.
- `bunx vitest run src/core/tests/ scripts/wasm-provenance.test.ts` passed 309 tests across 19 files.
- `bun run test:unit` passed 1,104 Vitest tests, 482 comparison tests and four checkpoint tests. One existing test was skipped.
- `bun run test:browser src/render/tests/synchronized-output.browser.test.ts src/render/tests/held-output.browser.test.ts src/render/canvas/renderer.browser.test.ts` passed 50 tests across three files in headless Chromium with SwiftShader. This proves correctness, not hardware performance.
- `bun run --cwd site docs:check` passed, including 17 authored pages and its Bun tests.
- Visually inspected held/released screenshots for Canvas, DOM, WebGL2, WebGPU and both worker backends. All retain the red "before" viewport during the hold and display the green "partial complete" viewport on release. Screenshot equality assertions compare the complete displayed region before and during each hold.

The detached 107 MiB pinned-source worktree was removed after building the bridge. `ghostty-vt.wasm` is unchanged. The rebuilt bridge grew from 20,910 to 20,965 bytes; its input and artifact hashes were updated. No upstream source changes or package version bump.

Direct investigation, implementation and review replaced the playbook delegation steps because the task forbids other agents. The repository Vitest browser workflow replaced Fregat-specific verification. Independent review and merge belong to the coordinator.

## Independent review corrections

The review at 8a0278c identified three reproduced bugs. A late-created state threw `TypeError: Cannot read properties of undefined (reading 'blinking')`; it now exposes an empty viewport and hidden cursor while its renderer waits for a first snapshot. The six-test core regression file passes.

A held atlas repaint followed by timeout exposed stale accessibility for equal-length replacement. All seven renderer/entry combinations failed with expected `timeout rendered`, received `partial complete`. Accessibility now includes the submitted native snapshot identity. Cursor-blink repaints reuse that identity and do not schedule redundant accessibility timers. All seven combinations pass, including Canvas pixels.

Canvas and both worker GPU backends reported drawn timestamps about one millisecond after a held write, before release. Render snapshots and worker state now carry hold status. Held clean updates and repaints cannot acknowledge output. The timing tracker waits for release, including timeout, without exhausting its failed-renderer allowance. Browser regressions cover both timeout and explicit reset after clean updates and forced held repaints. A fake-clock regression failed before this fix and passes after it.

This review run owns only `/work/worktrees/ghostty-webgpu/dec2026-review`, its installed dependencies, build output and Vitest screenshots. Existing shared checkouts, caches and services remain owned by their current consumers. Vitest and the heavy runner own child-process teardown; remove the worktree after pushing and reporting.

## Existing multiple-state limitation

Deferred outside this hold correction. The review reproduced missing incremental updates in a second render state without mode 2026. Reproducer: create one terminal and two render states; write `old`; update and acknowledge both; write ` before`; update both and read their first text rows. The second remains `old`. The native update consumes terminal damage for the first state. A fix needs a shared snapshot/fan-out design or independent terminal damage accounting, rather than another hold branch. No issue was opened. This receipt owns the follow-up context for the coordinator.

The broader six-file browser run passed 231 tests and exposed one existing blink-timer regression caused by comparing every painted frame. Comparing `snapshotVersion` instead retains the accessibility idle behavior while detecting held text release. The two affected browser files are rerun together after that correction. The full unit command passed 1,106 Vitest tests with one existing skip, 482 comparison tests and four checkpoint tests. Docs checks passed, including seven Bun tests. Both build and static gates passed. Re-inspected held/timeout screenshots on all seven backends.

Final review gate: `bun run test:browser src/render/tests/synchronized-output.browser.test.ts src/dom/tests/output-timing.browser.test.ts src/worker/terminal.browser.test.ts src/dom/tests/submitted-accessibility.browser.test.ts src/render/tests/held-output.browser.test.ts src/render/canvas/renderer.browser.test.ts` passed all 232 tests across six files. The affected two-file rerun passed all 46 tests. No binary, version, README or upstream changes in this review correction.
