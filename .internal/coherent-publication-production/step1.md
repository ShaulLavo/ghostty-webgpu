# Coherent publication step 1

Status: Approved layer 1 of the cumulative-qualified three-step publication stack.

## Ownership model

Each subscriber keeps its own native current, previous and pending slots and revision-keyed text
cache. Native dirty rows receive fresh text revisions. Current and previous text share one reader;
no previous-text reader remains. Discard clears only that subscriber's cache in this step.
Selective discard invalidation remains step 2, observer rewiring step 3 and row-identity matching
step 4. No shared displayed store or two-slot design is introduced.

Cached text owns its row-sized records and grapheme span at extraction. Grapheme offsets are
rebased to the owned row. ASCII rows own their blank bitmap and decoded string. Live and painter
readers keep their packet representation. There is no later compaction pass and no conditional
paint-row text cache. Acceptance retires obsolete cache entries from already known revisions,
without native reads or wasm allocation. Each capture has a distinct descriptor while native
handles recycle. Owned rows remain readable after retirement and disposal.

## Correctness

The original memoization test fails on main because a previous-frame read repeats two native
extractions. The lifetime regression fails on the initial cache because twelve rows remain after
only eight are readable. Both pass after repair.

The A57-derived progressively frozen 40×100 Unicode viewport is the hard ownership gate. Main
retains 50,000 copied bytes; the unsafe cache retained 2,525,000 bytes, or 50.5 packets. The row-owned
reader now retains exactly 50,000 bytes and releases all copied buffers after the final viewport
is dropped. The counter covers copied Uint32 records and graphemes, not strings, native/GPU
memory or process RSS. The test also preserves immutable owned cells and continuations after
native disposal. A separate ASCII case covers blank flags across bitmap words.

Independent histories, unequal cadence, overlapping captures, different discard/retry output,
partial capture/extraction failure, eager-extraction acknowledgement failure, resize and disposal
remain covered. Full browser qualification includes frame/text observers, displayed versus live
reads, accessibility, links, selection, DEC 2026 holds, displayed snapshots and worker publication.

The A55–A57 ledger and X7 mapping were read. Historical regression fixtures are reused. The
rejected compaction implementation is not restored. The older supplied-row observer retention
case remains distinct from the native text path repaired here.

## Qualification

Application source is `dc5a71aa2047fe2ae78ddc1eff0b77c28a5a8837`.
Main baseline is `f8f927dabcb2c08bf621740c1b661ddf91722bb0`.
The unsafe cache on the same main is `0e1994bfaf2f3ee80aea377b116c23a9fbe7ec9f`.
The checked-in core wasm is unchanged; the bridge was generated against official pinned upstream
with Zig 0.16.0. Feature versions remain unchanged.

Passed: build, typecheck, lint, format check, 1,185 unit tests with one skip, extension verification
and package checks, docs checks, and the full browser suite with 1,145 passed and seven skipped
across 67 files. Extension preparation completed before the browser suite.

Fresh counterbalanced hardware pairs use 200×50, DPR 2, one and sixteen terminals, dense and
scroll, 180 measured steps after thirty warmup steps, and two pairs per cell. Each arm gets a
fresh page. PC uses headed Chromium 153.0.8010.12 on RTX 3060 Ti, WebGL2 and hardware WebGPU.
Mac uses the same Chromium version on M1 Metal, AC power and the agent lock. PC uses quiet
heavy-runner admission and checks two GiB free VRAM before each browser.

All 96 pairs match the checked final text, callback counts, parsed writes and submitted frames.
Separate observer-parity cohorts also match full observer payload digests. Presentations and
energy are unmeasured. CPU results are experimental two-pair medians.

The main-reference heap increase at sixteen observed terminals is below one MiB in every cell.
Maximum measured increase is about 0.35 MiB on Mac scroll. Normal-path wasm stays at its baseline.
The two-MiB reduction belongs to later representation removal and is not claimed for this step.

## Ownership cost and stop

The isolated comparison changes only packet ownership, from unsafe cache to row-owned cache.
Numbers are renderer CPU milliseconds per loop at sixteen observed terminals.

| Host/backend | Workload | Before | After | Change |
| ------------ | -------- | -----: | ----: | -----: |
| PC WebGL2    | dense    |  36.69 | 37.78 |  +3.0% |
| PC WebGL2    | scroll   |  16.64 | 18.81 | +13.0% |
| PC WebGPU    | dense    |  27.25 | 27.53 |  +1.0% |
| PC WebGPU    | scroll   |  14.28 | 14.69 |  +2.9% |
| Mac WebGPU   | dense    |  36.79 | 37.95 |  +3.2% |
| Mac WebGPU   | scroll   |  18.58 | 19.13 |  +3.0% |

PC WebGL2 scroll rises in both pairs: 16.22 to 18.67 ms and 17.06 to 18.94 ms, about +15.1%
and +11.1%. This exceeds the coordinator's roughly five percent ownership-cost stop threshold,
so no branch is pushed, no PR is opened and no later step is started.

A finite light-class React Router diagnostic was active during that PC cohort. The heavy runner
permits light jobs inside a quiet reservation. Keep this limitation with the data; the result does
not establish that the full thirteen percent is intrinsic to row ownership. The first admission
expired before any samples, then the identical full cohort was requeued. No scored samples were
replaced.

Owner decisions: first repeat PC WebGL2, sixteen terminals, scroll, against the unsafe control
in a window without a concurrent finite CPU workload. If the large loss repeats, profile the
row-owned path before choosing a different representation. Do not silently restore the old
compaction pass or discard the ownership guard. Source remains frozen until that decision.

The previous intermediate gate allows up to one MiB extra JS heap at sixteen observed terminals.
By the end of step 3, JS heap must be at or below main and both scroll and dense CPU must improve
at sixteen terminals. Those later gates remain in force.

## Evidence

Raw packets, logs, scripts and the decision trail are retained at
`/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step1/`.
Main-reference packets are `pc-owned-main-{normal,parity}.json` and
`mac-owned-{normal,parity}.json`. Isolated cost is `pc-owned-cost.json` and `mac-owned-cost.json`.
The exact ownership red/green logs are `own-exact-red.log`, `own-green.log` and `own-checks.log`.
All task-created execution resources are removed on both hosts after retaining this checkpoint.

## Light-excluding confirmation

The coordinator authorized an external drain repeat excluding light jobs. The task published
`drain.request`, took all three slot locks and the admission lock, and ran a bounded 590-second
systemd unit. Before and after snapshots show only the pre-existing declared server running;
light requests remained queued. The request, locks, process group and transient unit were
released after the run. Raw data: `pc-owned-clean-cost.json`, with queue snapshots and the
rerunnable `clean-repeat.py` in the report directory.

The clean WebGL2, sixteen-terminal ownership comparison gives dense 24.61 to 26.78 ms per loop,
about +8.8%, and scroll 12.17 to 13.08 ms, about +7.5%. Scroll pairs rise +6.3% and +8.8%.
Step 1 therefore remains unpublished by itself. Per the coordinator's next instruction, steps 2
and 3 are carried locally. All three will be published as a stack only if the cumulative
sixteen-terminal heap and CPU gate passes on both hosts. The stack must state this layer's
transient ownership cost.

## Stack qualification

The coordinator authorized carrying the transient ownership cost until step 3. The combined
three-step implementation passes the normal sixteen-terminal CPU and heap gate on PC WebGL2,
PC WebGPU and M1 WebGPU, with equal observer payloads. Dense CPU improves about 15–18% and
scroll about 20–23%; normal heap is below main in all six cells and wasm is two MiB lower.
This layer remains individually reviewable and functionally green. Its measured standalone
ownership cost is about +8.8% dense and +7.5% scroll in the light-excluding PC repeat. It is
published as part of the verified stack, rather than as a standalone performance improvement.
