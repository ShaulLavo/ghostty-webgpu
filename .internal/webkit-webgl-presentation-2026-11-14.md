# WebKit WebGL presentation

The worker starts from PR 134 snapshot `3e46eecf627ad5d42dbfd4ac558c033f66a248af`.
It subsequently merges PR 134 integration `44a7a1dce6d74b431b36e3f9f0b831d5385493da`.
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
`webgl-presentation-probe.ts` is the standalone probe. Copy it into this worktree's
`.internal/` directory so its installed dependency imports resolve. Run
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
pass unchanged.

The remaining font-resource case reproduces in a plain Canvas2D control on this PC.
With a missing first family, initial and replacement A glyphs have system-font width
13.33984375 and identical pixels. The direct-family and loaded-primary-family controls
both have width 11.999984741210938 and 396 changed bytes after replacement. This uses
the exact before/replacement font resources without any terminal or rasterizer code.
The Boat host does not reproduce the missing-first-family behavior, so the PC result
is the relevant platform-specific evidence. `font-control-pc.json` retains it.

The fixture now loads a space-only primary family. A, M, and g still require the
second family, so both fallback resource replacement and its changed-metric control
remain covered by the original exact assertions. The WebKit font-resource file now
passes 11 cases with its two existing WebGPU capability exclusions. No font handling
or rasterization product source changes are needed.

The shader package's ambient types now include Bun and the Playwright browser provider,
matching the shared helpers' Promise and screenshot declarations. Compiler target and
library remain ES2023. Commit `72f5ac10cf43bf28720951d45c50126e0d6244fd` isolates this
single configuration-file repair for the coordinator to cherry-pick into PR 134.

The changed original test files have no native stage registration in the current
`scripts/ios-browser-stages.ts` graph. Native coverage counts and exclusions stay intact.
The coordinator receives the exact changed paths for the native-registration worker.
