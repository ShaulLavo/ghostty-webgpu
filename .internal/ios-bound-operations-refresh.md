# PR 108 public runtime refresh

Status: Source verification passed on November 9, 2026. Ready for the coordinator's new independent review and normal CI. Not merged.

## Integration

The owned branch first fast-forwarded to reviewed PR 108 head `d720dffab860bd3003b2915ffdcc2ae3ba7d072c`, then merged current main `c92a8a65fcbd1447f78937ce94da319a5666cb08` normally. The original head remains an ancestor. No history rewrite or replacement PR is needed.

Main already pins public Waffle 0.0.114, source `341bf1452d98e280a5c718af2775a839ff4042fa`, host interface 2, runtime archive SHA-256 `84a624f85f6843449ca2c96c113cb9609e8f4df634df17082e46246413f8245e`. Frozen installation uses that public archive. No SDK patch, development override, or unpublished program archive is used.

The adapter, its full retained connection-option checks, exact rejection handling, registrar restoration, and all 40 combined modes are unchanged from the reviewed and parent-fixed PR 108 head. The queued and settled retry-count controls remain. The browser fixture's clocks, assertions, and restoration remain byte-identical. Original test bodies, clocks, stage inventories, and completion 24 remain unchanged.

The merge required one semantic conflict fix. Both branches added `commandFailures` to the result fixture, producing a duplicate key despite Git's clean merge. The fixed fixture now equals main exactly. Root typechecking exposed that duplicate. Early typechecks before all package builds also reported missing generated declarations. Following CI's build order resolved those without source workarounds.

Two existing control defaults assumed `/work/tmp`, which GitHub-hosted runners do not provide. Both now use Node's `tmpdir()` and retain the existing explicit scratch override. No mode, assertion, clock, or ordinary test discovery changed. No package version or README changed.

## Source verification

Every substantial local command used `/work/heavy-runner/current/run.js` on the PC with owned finite jobs. The runner commit was `001a521b49e46abb5d2254280c47583c7be484c8`. No Mac, native host, device, or external worker was used.

These commands passed:

- `BUN_INSTALL_CACHE_DIR=/work/cache/bun bun install --frozen-lockfile --backend copyfile`.
- `bun run build`.
- `bun run verify:extensions`, including 102 line-editor tests, 22 shader tests, both package checks, builds, and types.
- `bun run typecheck`, `bun run lint`, and `bun run format:check`. Lint retains existing warnings outside this change.
- `node node_modules/vitest/vitest.mjs run --exclude scripts/ios-browser-bound-operations-combined.test.ts --exclude scripts/ios-browser-controls.test.ts`. This passed 1,920 tests. One existing test remained skipped. The local exclusions avoid executing browser controls and do not change committed discovery.
- `node node_modules/vitest/vitest.mjs run scripts/ios-browser-controls.test.ts --testNamePattern "published host and actual attached provider"`. All four CPU-only SDK controls passed. The 12 browser cases were not selected locally.
- `bun run --cwd site docs:check`. Examples compiled and seven supporting tests passed.
- `bun run pack:release`.
- `git diff --check`.

The CPU discovery includes the exact rejection, context denial, Buffer identity, public generic command type, original-source identity, result, lifecycle, and reporting tests. No new skip or weakened assertion is committed. The 40 combined admitted-DOM controls remain ordinary CI-discovered tests and were not replayed locally.

## Boundary exception

`bun run test:package:built` and its `NODE_ENV=production npm_config_omit=dev` variant were mistakenly treated as source/package-only checks. They both passed, but their package smoke helper invokes `renderer-fallback-smoke.ts`, which launches local headless Chromium for Canvas2D checks. This violated the assigned CPU-only boundary. The coordinator was told as soon as the nested browser invocation was identified. No browser or native qualification credit is claimed. The helper closed its browsers in `finally`, and no further browser commands were run. Inspect nested package commands before using them in a CPU-only lane.

No original suite or iPhone test ran. Native screenshot pixels, crop, DPR, Safari geometry, trusted input, and real-device qualification remain parent-owned. The original combined PNG data still proves synthetic transport only.

## Cleanup and handoff

The checkout had no dependencies, build output, or package artifacts before setup. Cleanup was checked on the execution host. Removed 758 MiB of root dependencies, workspace dependency links, 6.8 MiB of root build output, 368 KiB of addon output, and 2.6 MiB of package artifacts. Test helpers removed their scratch through their existing teardown. No command-type scratch remains under `scripts/`. No task test process remains in the checkout. The pre-existing Bun download cache and shared heavy-runner records remain shared resources, not retained task fixtures. No server, route, container, VM, browser profile, or reservation is retained.

The coordinator owns one new independent review of the integrated head, host CI, and the merge. This lane does not watch or merge the PR.
