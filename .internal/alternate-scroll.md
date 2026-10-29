# Alternate-screen wheel routing

Status: Approved. Step C of the Terminal track split.

## Native behavior

Inspected official Ghostty source at the package pin
`7b11f3dca034d8d24369ad3856afe57946d7902a` with `git show` from the existing reference clone.

- [modes.zig, line 366](https://github.com/ghostty-org/ghostty/blob/7b11f3dca034d8d24369ad3856afe57946d7902a/src/terminal/modes.zig#L366) defaults DECSET 1007 on.
- [Surface.zig, lines 3653 onward](https://github.com/ghostty-org/ghostty/blob/7b11f3dca034d8d24369ad3856afe57946d7902a/src/Surface.zig#L3653) converts vertical wheel rows only when the alternate screen is active, mouse tracking is off, and 1007 is on. It clears selection and uses CSI A/B normally or SS3 A/B with DECCKM. Horizontal alternate scroll is ignored.

## Reproduction and fix

Before the fix, a real Chromium WheelEvent after `CSI ?1049h CSI ?1007h` produced no data. The failing pointer test is committed before the implementation.

```text
AssertionError: expected [] to deeply equal [ '\u001b[A', '\u001b[B' ]
Test Files  1 failed (1)
Tests       1 failed | 13 skipped (14)
```

The old DOM route always called viewport scrolling when mouse tracking did not own the wheel. The new session `scrollWheel` operation reads native modes where the terminal state lives. Local and worker pointer adapters use the same operation. Explicit `scrollBy` remains viewport scrolling. The pointer controller retains cell-row accumulation and keeps horizontal residuals separate from vertical rows. No key encoder or keymap policy is involved.

## Verification

Executed from the prepared author worktree through `/work/platform-production/heavy/current/run.js`, except the pre-fix reproduction on a reserved Mac copy.

- `bun scripts/browser-tests.ts src/dom/tests/pointer-selection.browser.test.ts -t "sends cursor arrows"` on Mac Chromium before the fix. Failed as above.
- `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`. Passed. Lint reports existing warnings.
- `bunx vitest run src/core/tests/terminal.test.ts src/term/tests/session.test.ts`. 75 passed.
- `bun scripts/browser-tests.ts src/dom/tests/pointer-selection.browser.test.ts`. 14 passed in Linux Chromium with SwiftShader.
- `bun scripts/browser-tests.ts src/worker/terminal.browser.test.ts -t "routes alternate-screen wheel"`. 2 passed, 142 skipped. Exercises packaged main-thread and WebGL worker terminals.
- `bun run test:package`. Passed browser imports, TypeScript declarations, WASM assets and Canvas2D modes.

The first typecheck attempt preceded the build and failed because `dist` was absent. Building first resolved it. An initial selection assertion expected an empty string instead of the documented absent value, and the first packaged main-thread test sent input before its first submitted layout. Both test setup mistakes were corrected. The plain host `bun scripts/package-smoke.ts` check could not run because source checkouts omit assembled native resolver binaries. The browser package command above passed.

## Cleanup

The Mac copy, installed dependencies, archive and reservation were removed after the reproduction. Linux browser temp directories used a short `/work/tmp/twheel-*` path with EXIT and signal teardown; no task browser or server remains. Package-smoke removes its consumer workspace in `finally`.

The author checkout remains available for coordinator-requested fixes. Its installed dependencies and `dist` are retained for that purpose. The coordinator owns release of the checkout, after which the author runs `check-worktree-processes.py` and `git worktree remove`. No route, deployment, container, native binary or version change was created.
