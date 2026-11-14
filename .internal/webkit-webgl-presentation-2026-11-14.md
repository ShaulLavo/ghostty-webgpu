# WebKit WebGL presentation

The worker starts from PR 134 snapshot `3e46eecf627ad5d42dbfd4ac558c033f66a248af`.
All work and builds use the provided isolated worktree. Evidence is retained at
`/work/reports/goals/ghostty-shell-20261114/webgl-followup`.

## Mechanism

A plain WebGL2 canvas reproduces the stale visible pixels without any Ghostty code.
With `antialias: false` and `preserveDrawingBuffer: false`, clearing red presents the
canvas's CSS background. Clearing green next presents red. Immediate GPU readback
contains the requested red and green respectively. Extra animation frames, `flush()`,
and `finish()` do not repair presentation.

The independent probe runs on Playwright 1.63.0's WebKit 26.6. Both WPE headless and
GTK on an isolated Xvfb display reproduce it. GTK's operating-system X11 screenshots
match the stale Playwright screenshots. This is actual stale compositor output,
not a screenshot-only limitation. The controls with antialiasing enabled or with
the drawing buffer preserved present red and green correctly.

`gtk-control.json`, `wpe-control.json`, and their PNGs retain the independent evidence.
`webgl-presentation-probe.ts` is the standalone probe, run from this worktree with
`GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a bun <probe> --headed` for GTK.

## Change

Preserve the terminal renderer's and shader output pass's WebGL drawing buffers.
This uses the same context contract for every browser. No browser-name branch,
atlas change, frame-builder change, extra repaint, or relaxed pixel assertion is added.
Buffer retention may require browser-dependent storage or copying. There is no claim
of a performance improvement.

The existing compositor regression additionally checks that its initial image remains
exact after two idle browser frames without another renderer submission. The fallback
fixture waits for its double-click selection to be submitted before discovering links.
Link discovery deliberately rejects reads when the submitted native snapshot is stale.
Its original color, selection, link, input, and layout assertions remain intact.

## Validation

`fail-first.log` runs the strengthened compositor regression and the two shader
regressions against the original contexts after rebuilding root and shaders. It reports
three failures. Buffer retention alone makes the Unicode, BiDi WebGL selections,
retained Zig frames, square-cell dots, compositor, and shader presentation assertions
pass unchanged. The separate font-resource test's missing-first-family case still
captures identical blank glyphs before replacement and from a fresh terminal.
That font cause belongs to the Canvas/font worker.

The original changed test files have no native stage registration in the current
`scripts/ios-browser-stages.ts` graph. Native coverage counts and exclusions stay intact.
The coordinator receives the exact changed paths for the native-registration worker.
