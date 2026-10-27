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
- `bun run --cwd site docs:check` passed, including 17 authored pages and its five Bun tests.
- Visually inspected held/released screenshots for Canvas, DOM, WebGL2, WebGPU and both worker backends. All retain the red "before" viewport during the hold and display the green "partial complete" viewport on release. Screenshot equality assertions compare the complete displayed region before and during each hold.

The detached 107 MiB pinned-source worktree was removed after building the bridge. `ghostty-vt.wasm` is unchanged. The rebuilt bridge grew from 20,910 to 20,965 bytes; its input and artifact hashes were updated. No upstream source changes or package version bump.

Direct investigation, implementation and review replaced the playbook delegation steps because the task forbids other agents. The repository Vitest browser workflow replaced Fregat-specific verification. Independent review and merge belong to the coordinator.
