# Firefox interaction baseline

Base is `5c6d00f076047bdc4090454543ec56d31198c94d`. Logs are in
`/work/reports/goals/ghostty-shell-20261114/interactions` on the PC.

## Findings

The focused baseline reproduced three public hotkeys failures. Firefox exposes empty
data through a constructor-supplied synthetic paste event, so the terminal correctly
sent empty bracketed paste. The fixture now preserves its `DataTransfer` through an
own `clipboardData` property, as existing terminal-input fixtures already do. It checks
the supplied text before dispatch and keeps the complete output assertion.

The other assigned Firefox failures were caused by suite setup. The full-suite log
shows unresolved optional shader and line-editor package imports. The resulting Vite
error overlay intercepted link and clipboard clicks and dimmed BiDi screenshot pixels
from `[17, 17, 17]` to `[5, 5, 5]`. All of these tests pass unchanged in the focused run.
Build the optional packages before a full-suite run. Root `build` does not build them.

## Validation

Run `bun run build`, then use the following command with `GHOSTTY_BROWSER_ENGINE`
set to `firefox`, `chromium`, or `webkit` and
`PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright`.

```sh
bun run test:browser src/dom/tests/links.browser.test.ts \
  src/extensions/hotkeys/tests/focus.browser.test.ts \
  src/bidi/interactions.browser.test.ts \
  src/dom/tests/selection-packaged.browser.test.ts --reporter=verbose
```

The Firefox baseline had 97 passing tests, three failures, and 11 existing WebGPU
skips. After the fixture fix, Firefox has 100 passing tests and the same 11 skips.
Chromium passes all 111 tests. Both Firefox packaged real clipboard cases pass.

Root build, optional line-editor and shader builds, typecheck, lint, and formatting
checks pass. Lint reports existing warnings. No product source or version changes.

## Linux WebKit comparison

WebKit passes all 21 hotkeys cases and all 34 link cases. The full comparison has
77 passes, 12 failures, and 22 existing capability skips. Six failures are BiDi
main-thread WebGL screenshot highlights, which show the canvas background despite
correct selected cells in frame snapshots. Six packaged worker cases request WebGL
on a transferred OffscreenCanvas that this engine cannot provide and fail with
`renderer.webgl`, code `capability`, status 501.

The existing `src/bidi/tests/browser-capabilities.ts` has standalone screenshot and
worker WebGL probes for these engine limitations. No new skip or assertion relaxation
was added here. The comparison was sent to the coordinator for the WebKit lane.
Reproduce with the command above and `GHOSTTY_BROWSER_ENGINE=webkit`; the exact
assertions and stack traces are in `webkit-fixed.log`.

## Cleanup

Runs used the PC heavy runner and a private `/work/tmp/gwi-*` directory with an EXIT
trap installed before each test command. Browser descendants exited and those scratch
directories were removed. Generated selection screenshots are restored or removed.
No services, routes, extra checkouts, downloads outside dependency caches, or native
device resources were created. The isolated worktree remains for review; validation
logs remain in the report directory.
