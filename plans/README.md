# Product roadmap

Updated 2026-09-05 after the product direction review.

## Product and finish line

Build a standalone, embeddable Ghostty terminal library that people choose over ghostty-web.
Platform is one real consumer. The product must also work well for independent browser applications
and developers migrating existing ghostty-web integrations.

The ambition is a better experience across terminal behavior, visual quality, responsiveness,
resource use, browser coverage, customization, installation, and integration. Claims need direct
evidence against a pinned ghostty-web release. A newer graphics API or a green unit suite alone
cannot establish superiority.

**The active milestone is [016: ghostty-web replacement readiness](016-ghostty-web-replacement-readiness.md).**
It owns the migration contract, remaining useful API gaps, browser distribution, comparison evidence,
and the decision to call the product ready. Start with its baseline and consumer fixtures, then
close the gaps those fixtures expose.

The current assessment is **preview**. Renderer fallbacks and runtime WebGL recovery are implemented.
Useful compatibility APIs, independent package readiness, current WebGPU presentation evidence,
and direct comparisons still need work. No implementation or test is declared complete by this
roadmap change.

## Active work

| Plan | Milestone                         | Next action                                     | Status      |
| ---- | --------------------------------- | ----------------------------------------------- | ----------- |
| 016  | ghostty-web replacement readiness | Close fixture gaps and expand packed comparison | IN PROGRESS |

Plan 016 is the sole execution queue. Its package and API work can proceed independently after the
baseline is recorded. Browser correctness does not depend on completing every xterm extension.
A missing upstream hook blocks the affected capability, not unrelated useful work.

## Scope decisions

| Area                                               | Decision                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ghostty behavior and rendering                     | Keep native Ghostty authority, correct text and Unicode, live themes, transparency, and damage-aware drawing.                                                                        |
| Renderer availability                              | Keep WebGPU first, WebGL2 second, Canvas2D last, plus recovery and resource disposal.                                                                                                |
| Migration and useful APIs                          | Keep initialization, fitting, buffer text reads, custom links, input, selection, clipboard, and lifecycle behavior required by ghostty-web consumers.                                |
| Browser quality                                    | Keep resizing, font readiness, accessibility, IME, browser coverage, and real displayed-output checks.                                                                               |
| Additional capabilities                            | Evaluate search, serialization, fonts, ligatures, images, and progress individually against baseline support and consumer needs. An addon package shape is not itself a requirement. |
| Native Ghostty config                              | Keep optional host integration. The browser package must build, install, and run without native resolver artifacts. Native artifacts retain their own validation.                    |
| Complete xterm certification                       | Retire it as the product release gate. Keep the ledger and existing tests as honest compatibility evidence.                                                                          |
| Separate headless product and alias package family | Defer until concrete consumers justify them. They are not prerequisites for the browser release.                                                                                     |

Do not remove working features merely to shorten the roadmap. Preserve useful implemented behavior
and tests. Promote an optional capability into active work when a baseline workflow or a concrete
consumer need justifies it. Existing ghostty-web functionality must be evaluated even when its
nearest old plan was an addon plan.

## Historical plans

Plans 001–008 record completed work. Plans 009–015 retain research, evidence, and known differences;
their former execution instructions, dependencies, and completion gates are inactive. Follow Plan
016 when deciding what to implement. A historical blocked or partial result remains unresolved
evidence, not an obligation to reproduce every xterm behavior.

| Plan | Historical work                                                                             | Disposition                                                                                  | Status     |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| 001  | [Renderer characterization and metrics](001-renderer-characterization-and-metrics.md)       | Completed renderer foundation                                                                | DONE       |
| 002  | [Cell effects and glyph geometry](002-separate-cell-effects-from-glyph-geometry.md)         | Completed renderer foundation                                                                | DONE       |
| 003  | [Cropped, style-aware glyphs](003-cropped-style-aware-glyph-rasterization.md)               | Completed renderer foundation                                                                | DONE       |
| 004  | [Paged texture arrays](004-paged-texture-array-atlas.md)                                    | Completed renderer foundation                                                                | DONE       |
| 005  | [Font geometry and renderer qualification](005-font-geometry-and-renderer-qualification.md) | Completed qualification at its recorded revision                                             | DONE       |
| 006  | [Hotkeys and input ownership](006-vanilla-hotkeys-and-input-ownership.md)                   | Completed input foundation                                                                   | DONE       |
| 007  | [Pinned xterm reference and ledger](007-xterm-reference-and-parity-ledger.md)               | Retain reference and evidence tooling                                                        | DONE       |
| 008  | [Terminal facade and lifecycle](008-xterm-terminal-facade.md)                               | Preserve implemented behavior and documented differences                                     | DONE       |
| 009  | [Extension surfaces](009-xterm-extension-surfaces.md)                                       | Useful buffer and link APIs move to 016; exact extension parity is not a shared prerequisite | SUPERSEDED |
| 010  | [Browser interaction](010-xterm-browser-interaction-parity.md)                              | Quality and performance evidence move to 016 independently of full 009                       | SUPERSEDED |
| 011  | [Foundation addons](011-xterm-foundation-addons.md)                                         | Consumer capabilities move to 016 individually                                               | SUPERSEDED |
| 012  | [Data and Unicode addons](012-xterm-data-and-unicode-addons.md)                             | Useful data access and Unicode quality remain; exact addon replication is optional           | SUPERSEDED |
| 013  | [Rendering and image addons](013-xterm-rendering-and-image-addons.md)                       | Evaluate fonts and images individually; keep implemented renderer fallbacks                  | SUPERSEDED |
| 014  | [Headless and alias packages](014-xterm-headless-and-packaging.md)                          | Separate product and package family await consumer demand                                    | DEFERRED   |
| 015  | [Zero-gap xterm certification](015-xterm-parity-certification.md)                           | Replaced as the product finish line by 016                                                   | RETIRED    |

Active status values are `TODO`, `IN PROGRESS`, `BLOCKED`, and `DONE`. Historical dispositions also
include `SUPERSEDED`, `DEFERRED`, `RETIRED`, and `REJECTED`. None of those dispositions means that
unfinished code became compatible.

## Evidence and implementation boundaries

- [The xterm ledger](../docs/xterm-parity.md) records supported behavior and remaining differences.
  Its owner plan numbers are historical provenance. `bun run xterm:parity` checks inventory and
  evidence integrity; it does not define ghostty-web replacement readiness.
- [Physical acceptance](../docs/phase-3-acceptance.md) and
  [renderer baseline evidence](../docs/renderer-refactor-baseline.md) apply to their recorded
  revisions and environments. Preserve earlier passes and failures. Recheck changed behavior
  before making a current release claim.
- Ghostty remains the parser, Unicode, buffer, selection, and damage authority. Do not invent a
  second parser, shadow scrollback, or unsupported native state to fill an API gap.
- Keep the pinned official upstream build and no maintained fork requirement from `AGENTS.md`.
  Pursue missing public native hooks upstream when a required capability needs them.
- Keep native byte transport, host input ownership, coherent font/grid geometry, recolorable glyph
  coverage, premultiplied transparency, and generation-safe atlas reuse.
- Keep event-driven rendering. An idle terminal without an active visual transition must not run
  a standing animation loop or maintenance timer.
- Observe the displayed canvas without drawing again. Headless software GPU results prove
  correctness only when pixels are actually presented; performance requires headed hardware runs.
- Existing xterm references and test packages remain development inputs, outside shipped browser
  artifacts. Retaining comparison tests does not commit the product to full xterm certification.
