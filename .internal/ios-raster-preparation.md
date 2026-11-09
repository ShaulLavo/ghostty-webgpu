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
