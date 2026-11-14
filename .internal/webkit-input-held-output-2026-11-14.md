# WebKit paste and held-output fixtures

The worker used the isolated `t3/webkit-input-held-output` worktree, based on PR 134
snapshot `3e46eecf627ad5d42dbfd4ac558c033f66a248af`. No product source changed.

## Paste platform

Linux Playwright WebKit reports `navigator.platform` as `Linux x86_64` and a
Macintosh Safari user agent. The hotkeys library's detector chooses Mac from the
user agent. The terminal input controller correctly prefers the platform after
PR 133. The old fixture consequently sends Command-V to a Linux controller and
fails its `defaultPrevented === false` assertion before reaching the paste event.

The fixture now supplies explicit Linux, Mac, and iPhone platforms and their
native paste modifiers. It restores navigator properties during teardown. Focus
reports, shortcut cancellation, and the exact pasted bytes retain their original
assertions. The snapshot already assigns the actual `clipboardData` property;
this change adds no clipboard event workaround.

## Xterm reference

The default xterm WebGL addon returns compositor pixel `[0, 0, 0, 255]` where the
reference test expects `[41, 91, 151, 255]`. This occurs before synchronized output
is enabled. The terminal buffer contains the expected background color, and the
screen and canvas both measure 264 by 124 at DPR 1.

Selecting the WebGL canvas instead of the transparent link canvas does not fix
the failure. Enabling only the addon's public `preserveDrawingBuffer` option
does. All diagnostic readback and canvas-selection edits were removed. The
original compositor screenshots, exact colors, hold/release assertions, and
frame counts pass. A standalone WebGL clear probe passes with preservation both
enabled and disabled, so this does not establish a general WebGL clearing defect.
The adjustment belongs to the xterm reference fixture. It changes no Ghostty
renderer or production input semantics.

## Validation

All commands ran through the PC heavy runner, with task-owned temporary
directories removed by an exit trap. Root, line-editor, and shaders builds ran
before the first browser reproduction.

- Before the fix, the two complete WebKit files report 2 failed, 32 passed, and
  one existing worker-WebGL capability skip.
- After the fix, the same WebKit files report 36 passed and one existing skip.
- Chromium reports all 37 cases passed in those files.
- Firefox passes the three paste cases and xterm reference. The other cases were
  excluded by the focused test-name filter.
- Typecheck, lint, and the repository format check pass. Lint reports existing
  repository warnings.

Neither edited test is a source registered by `scripts/ios-browser-stages.ts`.
No native source hash or case registration needs changing. PR 131 and PR 132 are
not copied into this branch.

Evidence and diagnostic logs are under
`/work/reports/goals/ghostty-shell-20261114/residual-followup`.

Fix Root Causes led to inspecting the platform values and separating xterm
buffer preservation from canvas selection and diagnostic readback. Model the
Domain led to explicit platform/modifier cases. Prove It Works required the
unchanged byte and pixel assertions on real browsers. Delegation and a separate
comment-review agent were omitted under the worker's no-subagents instruction.
