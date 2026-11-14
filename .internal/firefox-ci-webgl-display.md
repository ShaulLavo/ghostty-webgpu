# Firefox CI WebGL display

Status: Approved. The coordinator owns independent review, hosted CI, and merge.

The reproduction starts at CI head `815966176fd005e6a4b717a16b45d85e87dc9d90`.
All four Firefox shards fail to acquire WebGL2, including independent fixtures and
the shader addon. The ligature fixture fails in `beforeAll`, before rendering.
The missing source-map warnings are separate build-artifact diagnostics.

## Plain control

The PC heavy runner pulled the exact Playwright 1.63.0 Noble amd64 image pinned
by CI, digest `bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`.
It contains Firefox 155.0, Mesa 25.2.8, libGL, libEGL, and Xvfb. No packages or
drivers were added to the image. The control imports Playwright, creates a plain
canvas, clears it, and reads one pixel. It imports no terminal code.

Default headless Firefox reports `AllowWebgl2:false restricts context creation on
this system`. Setting only `webgl.force-enabled` changes the failure to
`FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS`. Headed Firefox under Xvfb works, with
or without that preference. Default headless Firefox under Xvfb also works and
reads `[64,128,191,255]` with GL error zero. Its renderer is `llvmpipe, or similar`.
This is software-rendered correctness evidence.

The namespace sandbox warning occurs in both failing and successful launches.
Headed Xvfb also reports missing DBus and DRI3 acceleration while still passing
the pixel control. Those warnings do not require extra packages for this fix.

The workflow therefore wraps only Firefox's existing test command in
`xvfb-run -a`. The browser stays headless. There are no launch preference changes,
new capability exclusions, or assertion changes. Chromium and WebKit retain
their existing commands. The workflow contract executes the shell for all three
engines and checks shard forwarding. A maintained plain WebGL2 test checks pixel
readback without any terminal renderer.

[Playwright documents Xvfb in its CI image](https://playwright.dev/docs/ci#running-headed).
[Mozilla tracks headless WebGL support](https://bugzilla.mozilla.org/show_bug.cgi?id=1375585),
but this image's control shows that a display suffices without headed mode.

## Validation and cleanup

Detailed commands, browser stderr, controls, and test logs are retained under
`/work/reports/goals/ghostty-shell-20261114/firefox-ci-gl`.
The initial fallback fixture attempt stopped before Vitest because the harness
mounted `bun` without `bunx`. That attempt is not baseline evidence. The harness
was corrected before the maintained baseline and shard validation.

The corrected root-user harness reproduces four failures without a display:
three fallback cases select `canvas2d` instead of `webgl2`, and the plain control
fails with `AllowWebgl2:false`. The same four tests pass under Xvfb.

All maintained runs use the unchanged runtime from the exact CI head, with no
renderer or fixture assertion changes:

- Firefox shard 2: 21 files passed, 215 tests passed, 59 skipped, zero failures,
  43.29 seconds.
- Firefox shard 4: 21 files passed, 357 tests passed, 141 skipped, zero failures,
  68.51 seconds.
- Workflow contracts: seven tests and 81 assertions passed, including nonzero
  browser exit propagation for all three engines.
- Package and optional package builds, full typecheck, formatting, docs checks,
  native bootstrap verification, and actionlint with ShellCheck passed.
- Lint passed with 37 existing warnings and zero errors.

The new plain control is committed before the workflow correction. The full
three-engine suite and native-device checks remain with hosted CI and Product
shell respectively. Local runs are correctness checks, not performance evidence.

Cleanup removed every task-owned container, the 3,558,061,650-byte image, the
795 MiB dependency tree, package build outputs, and generated browser artifacts.
The pre-existing `hello-world` image remains. Docker and the isolated worktree
were checked after teardown. Only small logs and rerunnable scripts remain in
the report directory, owned by this task's coordinator for review. There is no
retained image or pending image removal.
