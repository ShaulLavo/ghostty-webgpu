# Verification and cleanup

The baseline exporter passes with 80 baseline rows, 400 calibrated Mac energy-family rows, 48 hosted entry rows, 68 completion rows, five worker heap responses and 40 backend text-parity groups. The corpus matrix contains 160 individual baseline observations. Each baseline row has two repetitions and 120 logical updates. No performance ratio is promoted as qualified.

The required checks ran against a clean copy of the measured runtime revision on the Mac:

```sh
export PATH=$HOME/.local/share/mise/shims:$HOME/.bun/bin:/opt/homebrew/bin:$PATH
export TMPDIR=$HOME/tmp/ghw-p0a-unit-t
bun run build
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run --cwd site docs:check
```

Build and typecheck pass. Lint passes with existing warnings outside the packet. Formatting passes. Unit verification passes with 1,106 Vitest tests, one skipped test, 482 comparison tests and four checkpoint tests. Site verification passes the authored examples and seven worker/PTY tests. Logs retain the earlier staging-environment failures described in `reproduce.md`. No source change was needed to resolve them. The site check needed the staged site's own workspace dependency links in addition to the root dependency links.

The final packet also passes `bun run lint`, `bun run format:check`, `git diff --check`, `node --check` for both diagnostic entry scripts and `gzip -dc .internal/benchmarks/baseline-2026-10/harness.patch.gz | git apply --check -`. Browser evidence is the actual headed hardware acquisition on both hosts. No production browser-test source changed.

All task-owned PC and Mac browser processes, servers and the PC browser temporary directory were removed. Localhost ports 41877, 41878 and 41879 have no task listener. The Mac's original CoreGraphics display mode 8 was read back after restoration. Its 1.4 GiB staged source/dependency/profile tree and 2.5 MiB test temporary directory were deleted and absence checked on the Mac. The two 128 MiB source-transfer archives and the unused comparison build were deleted from the PC. Shared caches and other lanes' processes and locks were preserved.

The raw packet remains under `/work/reports/ghostty-webgpu-next-2026-10/p0a/`, about 301 MiB. Its current consumers are Phase 1 comparisons and review of the missing M2/M5 channels. The wave coordinator owns retention and can remove it when those controls and investigations are retired. The PR branch preserves the small summaries and reproducers independently. The exclusive PC worktree is removed after pushing the PR. No route, service, container or deployment was created.

The binding brief forbids nested agents, so comment review and diff review were performed directly. No new explanatory comments were added to the executable packet scripts. The original diagnostic patch retains its source comments as acquisition context. Independent PR review belongs to the coordinator.

## Independent review follow-up

The new registry has 32 required channel IDs. `summary.json` schema 2 contains the full inventory and structured unresolved rows; M2, M5, M7 and M8 remain partial. The exporter still reproduces the original five CSVs unchanged and checks the original 80 baseline rows, 400 energy-family rows and 40 text-parity groups.

The PC review cohort adds 24 owned-buffer arms on WebGPU/WebGL2, covering three payload sizes in clone/transfer/transfer/clone order. All 576 measured writes have contiguous acknowledgements, one native parser call per update, expected sender ownership/detachment and equal text/submission counts within each four-arm group. New adapter observations come from current devices/contexts after actual loss, not the cached initial page info. The first main WebGL attempt fails on an extension query during loss; the diagnostic now returns lost-context state first. Its recovery-only rerun was not launched because quiet admission expired after 600 seconds. The Mac review cohort was not launched because F2 and then X7 held active job locks. Those channels are partial or blocked with evidence, not unsupported.

Review tests use a clean copy of the PR runtime with the packet overlaid, outside the instrumented measurement worktree. The root and site dependency links point to this lane's own install, and `TMPDIR=/work/tmp/ghw-p0ar1-unit-t` is a canonical sibling directory outside that source copy. This keeps the existing negative dependency-resolution tests isolated. No source runtime or public API changed.

The review required gates pass on the clean check copy: `bun run build`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:unit`, and `bun run --cwd site docs:check`. The result is 1,106 Vitest passes with one skip, 482 comparison passes, four checkpoint passes and seven site passes. `review-r1/gates.log` records the exact runner invocation and output. Final packet lint, format, JS syntax, patch applicability, original-CSV preservation and exporter ownership/sequence/text/submission/provenance checks also pass.

The review creates no Mac payload or process. Its blocked availability checks and active reservation snapshots are retained in `review-r1/`. PC browser/server consumers and the copied check tree stop before their browser temp, canonical test temp and check source/archive are deleted. Other lanes' processes, locks and caches are preserved. The new raw records remain with the coordinator for M7/M8 follow-up and Phase 1 comparisons; the review worktree is removed after the push.
