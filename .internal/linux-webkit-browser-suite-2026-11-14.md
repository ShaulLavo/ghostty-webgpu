# Linux WebKit browser suite

The worker started from `5c6d00f076047bdc4090454543ec56d31198c94d` in its isolated worktree.
Linux tests ran through the PC heavy runner. No Mac or iPhone work was performed.

## Setup

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd packages/shaders build
bun run --cwd packages/line-editor build
GHOSTTY_BROWSER_ENGINE=webkit bun run test:browser
```

Both optional package builds are necessary. Missing package output can create a Vite error
overlay and contaminate input and screenshot observations. Initial baseline counts are
historical diagnostics, not renderer correctness evidence.

## Capability checks

`src/render/tests/webgpu-capability.ts` skips a required GPU case only when `navigator.gpu`
is absent. Adapter and device acquisition still fail normally when the API exists.
GPU sentinels are optional in mixed suites so WebGL and fallback tests still execute.
The selector tests exercise the real fallback with WebGPU globals absent.

`src/render/tests/worker-webgl-capability.ts` reuses the existing transferred-canvas worker
probe. It excludes success paths only when that worker cannot acquire WebGL2. Explicit
capability-error tests remain active. Linux WebKit lacks this worker capability.

The `GPUAdapter` reference errors originated in GPU-only lifecycle fixtures, not the
terminal runtime. The product reports structured capability errors without those globals.

## Product fixes

PR 133, `ba25792dc5a246ef39c28fedac026b929d96631c`, contains only platform detection,
scrollbar geometry, and their browser regressions. Linux WebKit can report a Macintosh
user agent despite a Linux platform. The platform now takes precedence. Scrollbar thumb
height and position now share CSS layout arithmetic instead of independently rounded
layout and transform geometry.

The old source fails the Linux clipboard regression and the fractional scrollbar regression.
The fixed source passes seven Chromium cases and nine focused WebKit cases, including
integrated clipboard and terminal geometry coverage.

## Validation and remaining findings

The first diagnostic run reported 433 failed, 770 passed, and 294 skipped cases across 82
files. Its missing optional package output invalidates its screenshot and interaction verdicts.
The first run after both optional builds reported 44 failed, 637 passed, and 540 skipped
cases, with one shader iframe initialization error. The shader case passed when rerun alone.

Chromium passed 290 cases across the real GPU, selector, terminal UI, and packaged worker
suites with these capability checks. Typechecking, helper unit tests, lint, and formatting pass.
The maintained full WebKit suite is still being qualified; no supported renderer assertion
has been removed or weakened.

An independent, overlay-free canvas probe reproduced a WebKit font fallback discrepancy.
A first assignment of `24px MissingProbeFamily, ProbeFallback` measures `M` as 19.9921875,
despite a loaded ProbeFallback face whose direct measurement is 14.39996337890625.
The probe imports no terminal renderer and confirms no Vite overlay. This matches the
late-font tests' unexpected geometry change. Waiting for `document.fonts.ready`, loading
the base family, and loading the full family list did not resolve it. Those experiments
were reverted.

Detailed logs and the standalone probe are retained under
`/work/reports/goals/ghostty-shell-20261114/webkit`. Supported WebGL screenshot and Canvas
pixel parity failures need further diagnosis. They are not capability exclusions.
