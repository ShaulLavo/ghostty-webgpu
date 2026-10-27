# Verification receipt

All commands run from the X4 worktree through the PC shared queue, label `X4 required source gates`.

```sh
bun run build
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run test:browser src/worker/terminal.browser.test.ts
bun run --cwd site docs:check
```

All passed. Unit tests reported 93 passing files and one skipped file, 1,106 passing tests and one skipped test. The benchmark-tool suite passed 482 tests, and checkpoint tests passed four tests. The worker browser suite passed 133 tests. The docs checker compiled examples for 17 authored pages and passed seven site tests. Lint emitted existing warnings in unchanged files. Browser tests emitted the existing Vite dynamic-import warning for the Node file-URL helper.

The production source is unchanged from `d2ed8989a`. Later prototype edits also passed `bun run typecheck`, scoped oxlint, and scoped oxfmt. The custom browser cohort exercises those prototype edits directly.

The binding brief prohibits delegated workers, so architecture and comment review were done locally. No prototype comments or lint suppressions were added. The referenced `verify-fregat` skill is absent from the installed skill catalog; verification uses the repository's worker browser suite and the X4 browser instrument.

The corrected headless same-session mixed-edit cohort passed text, decoded RGBA pixels, and delivered-update equality at 4 and 16 terminals for 200×50 and 80×24. Both pooled lifecycle probes survived disposal of one session, a font/DPR change in terminal zero, and shared context loss/restoration. Surviving sessions published recovery frames; the disposed session published none. The receipt is `/work/reports/ghostty-webgpu-next-2026-10/x4-worker-pool/smoke-v3/smoke-v3.json`. These headless timings do not qualify performance.

The headed PC cohort completed all 48 arms in 24 counterbalanced same-browser pairs. All 240 per-terminal text/pixel comparisons match, with all 4,680 measured updates delivered by each arm. Worker heaps were attached in every arm; the independent receipt check found no process churn. The minimum free VRAM before launch was 6,817 MiB. Host publication passes, 16-terminal total memory fails, and one 4-terminal Unicode p99 case fails. Decision: REJECT this WebGL2 framebuffer/copy prototype. Raw data and the independent checker remain in the X4 report directory.
