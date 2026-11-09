# Six complete raster originals

Status: Approved source and CI preparation. Baseline: 9cd0226f3d0fd085af4df893a048fa97b24137c5, November 10, 2026.

Register `canvas-theme-cache` with 1 case, `canvas-zwj` with 10, `pixels` with 17,
`glyph-constraints` with 4, `sprites` with 12, and `displayed-pixels-fixture` with 1.
The last file uses Canvas2D, despite its WebGL directory.

Preserve every original byte and the original 20,000 ms theme-cache and 60,000 ms
contact-sheet clocks. Other cases use 15,000 ms, hooks 30,000 ms, and retries zero.
The current Waffle 0.0.114 accepts these positive finite clocks. Keep the PR 108
screenshot and viewport adapters and the original pixel oracles unchanged.

This PR does not execute native stages, add native acceptance credit, change the
canonical count of 25 files, or touch fixed exclusions or frozen attempts. The parent
owns review, native intake, and merge. Eligibility evidence is in
`/work/reports/goals/ghostty-iphone-eligibility/render-assessment.md` and `INVENTORY.md`.

## Local checks

The configured Node discovery includes the raster, source-inventory, and original
Canvas scroll contract tests. The complete adapter suite passed 278 tests in
48 files. The build, line-editor build, typecheck, lint, and formatting checks pass.
Lint reports existing warnings outside this change.

The CPU-only capture checks reuse the PR 123 setup. They pass the 36 original
CSS-scale saved paths and the original device-scale `save: false` options through
the installed official callbacks, stopping at browser lookup without pixel bytes.
The official callback adds its normal `save` or `base64` defaults. No callback is
replaced. This proves option and path admission, not native crop dimensions,
font pixels, DPR behavior, or contact-sheet tolerances. Those still need the
parent's native execution. Public Waffle constructor tests also admit all original
clocks without running a host or allocating a session.

Detailed commands and cleanup are in
`/work/reports/goals/ghostty-iphone-eligibility/batch-raster/HANDOFF.md`.
