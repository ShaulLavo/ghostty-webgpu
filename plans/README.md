# Product roadmap

Updated 2026-09-30 for the native API direction.

## Product and finish line

Build Ghostty for the web with its own native API. Platform is one consumer. The library also
serves independent browser applications with byte-based PTY traffic, automatic fitting, live
appearance, and WebGPU, WebGL2, and Canvas2D rendering.

The active milestone is [017: native API focus](017-native-api-focus.md). It owns facade removal,
history text reads, measured comparisons, and evidence-backed product positioning.

## Active work

| Plan | Milestone                                   | Status   |
| ---- | ------------------------------------------- | -------- |
| 017  | [Native API focus](017-native-api-focus.md) | APPROVED |

Follow Plan 017 when choosing work. The package is a preview. Current release claims need checks
against the built package and its consumers.

## Historical plans

Plans 001–006 record completed foundations. Plans 007–016 are historical and retired by Plan 017.
The plan files preserve their research, recorded results, and known differences. Their execution
instructions and completion gates are inactive.

| Plan | Historical work                                                                             | Disposition                                      |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 001  | [Renderer characterization and metrics](001-renderer-characterization-and-metrics.md)       | Completed renderer foundation                    |
| 002  | [Cell effects and glyph geometry](002-separate-cell-effects-from-glyph-geometry.md)         | Completed renderer foundation                    |
| 003  | [Cropped, style-aware glyphs](003-cropped-style-aware-glyph-rasterization.md)               | Completed renderer foundation                    |
| 004  | [Paged texture arrays](004-paged-texture-array-atlas.md)                                    | Completed renderer foundation                    |
| 005  | [Font geometry and renderer qualification](005-font-geometry-and-renderer-qualification.md) | Completed qualification at its recorded revision |
| 006  | [Hotkeys and input ownership](006-vanilla-hotkeys-and-input-ownership.md)                   | Completed input foundation                       |
| 007  | [Pinned xterm reference and ledger](007-xterm-reference-and-parity-ledger.md)               | Retired by 017                                   |
| 008  | [Terminal facade and lifecycle](008-xterm-terminal-facade.md)                               | Retired by 017                                   |
| 009  | [Extension surfaces](009-xterm-extension-surfaces.md)                                       | Retired by 017                                   |
| 010  | [Browser interaction](010-xterm-browser-interaction-parity.md)                              | Retired by 017                                   |
| 011  | [Foundation addons](011-xterm-foundation-addons.md)                                         | Retired by 017                                   |
| 012  | [Data and Unicode addons](012-xterm-data-and-unicode-addons.md)                             | Retired by 017                                   |
| 013  | [Rendering and image addons](013-xterm-rendering-and-image-addons.md)                       | Retired by 017                                   |
| 014  | [Headless and alias packages](014-xterm-headless-and-packaging.md)                          | Retired by 017                                   |
| 015  | [Zero-gap xterm certification](015-xterm-parity-certification.md)                           | Retired by 017                                   |
| 016  | [ghostty-web replacement readiness](016-ghostty-web-replacement-readiness.md)               | Retired by 017                                   |

## Evidence and implementation boundaries

- [Physical acceptance](../docs/phase-3-acceptance.md) and
  [renderer baseline evidence](../docs/renderer-refactor-baseline.md) apply to their recorded
  revisions and environments. Preserve earlier passes and failures. Recheck changed behavior
  before making a current release claim.
- Ghostty owns parsing, Unicode, buffers, selection, and damage. Use its public API for terminal
  state and history reads.
- Keep the pinned official upstream build without patches or a maintained fork, as `AGENTS.md`
  requires. Pursue missing native hooks upstream.
- Keep native byte transport, host input ownership, coherent font and grid geometry, recolorable
  glyph coverage, premultiplied transparency, and generation-safe atlas reuse.
- Keep event-driven rendering. An idle terminal without an active visual transition must not run
  a standing animation loop or maintenance timer.
- Observe the displayed canvas without drawing again. Headless software GPU results prove
  correctness only when pixels are presented. Performance requires headed hardware runs.
