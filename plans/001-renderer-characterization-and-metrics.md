# Plan 001: Establish renderer characterization and metrics

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src/render bench scripts docs package.json vitest.browser.config.ts`
> If an in-scope file changed, compare the “Current state” excerpts against the live code before
> proceeding. A contract mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / performance
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

The renderer is about to change its instance layouts, shaders, glyph bitmap contract, atlas
storage, and font geometry. Existing tests prove several isolated behaviors, but they do not expose
atlas upload bytes and do not provide one reusable fidelity scene across the refactor. This plan
freezes the observable contract and records a hardware baseline before structural work begins.

This is a characterization plan. It may add diagnostics and test infrastructure, but it must not
change rendered pixels, scheduling, atlas allocation policy, public options, or draw count.

## Current state

- `src/render/renderer.ts:43-50` exposes frame metrics but counts only instance-buffer uploads:

  ```ts
  export interface RendererMetrics {
    atlasEvictions: number
    deviceRestores: number
    draws: number
    rebuiltRows: number
    submittedFrames: number
    uploadedBytes: number
  }
  ```

- `src/render/atlas/atlas.ts:21-23` allocates one 2048×2048 page per kind by default. Each page's
  `consumeUpload()` returns its entire backing pixel array (`src/render/atlas/atlas.ts:64-75`).
- `src/render/atlas/gpu-textures.ts:33-46` calls `queue.writeTexture` for the full upload but exposes
  no byte counter, so the existing benchmark cannot see atlas traffic.
- `bench/renderer-benchmark-entry.ts:89-97` reports renderer metrics for four scenarios but has no
  glyph-churn scenario and no atlas page/cache/upload measurements.
- `src/render/atlas/canvas-rasterizer.browser.test.ts` checks stable Latin baselines and exact cell
  span sizes. `src/render/tests/text-pass.browser.test.ts` checks transparency, decorations,
  minimum contrast, and exactly two draws. Reuse these assertion styles; do not introduce image
  snapshots whose anti-aliasing differs by OS.
- The repository gate is `bun run verify`. Browser tests run in real Chromium through the separate
  `vitest.browser.config.ts`; Linux CI uses SwiftShader and intentionally skips only two successful
  multi-device replacement cases.

## Reference behavior

Use the immutable xterm.js reference commit
`8938fe37852995761d28c20edb74ee3986e8c438`:

- `TextureAtlas.ts` tracks rasterized glyph size/offset and page versions.
- `GlyphRenderer.ts` draws actual glyph quads separately from rectangle effects.
- `WebglRenderer.ts` derives CSS cell sizes from integer device dimensions.

Reference behavior, not WebGL API shape, is the contract. Do not copy xterm implementation code.

## Commands you will need

| Purpose           | Command                                                                                                              | Expected on success                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Install check     | `bun install --frozen-lockfile`                                                                                      | exit 0; `bun.lock` unchanged                           |
| Unit focus        | `bun run test:unit -- src/render/atlas/tests/atlas.test.ts`                                                          | all focused tests pass                                 |
| Browser focus     | `bun run test:browser -- src/render/tests/glyph-fidelity.browser.test.ts src/render/tests/text-pass.browser.test.ts` | all focused browser tests pass                         |
| CI launcher       | `CI=true bun run test:browser`                                                                                       | all supported browser tests pass                       |
| Full gate         | `bun run verify`                                                                                                     | typecheck, lint, format, unit, browser, build all pass |
| Quick benchmark   | `BENCH_WARMUP_SECONDS=1 BENCH_SAMPLE_SECONDS=3 bun run bench:renderer`                                               | exit 0; one result per scenario                        |
| Hardware baseline | `bun run bench:renderer`                                                                                             | exit 0; 30 samples per scenario                        |

## Scope

**In scope** (the only production/test/docs paths to modify):

- `src/render/renderer.ts`
- `src/render/atlas/atlas.ts`
- `src/render/atlas/gpu-textures.ts`
- `src/render/atlas/types.ts`
- `src/render/atlas/tests/atlas.test.ts`
- `src/render/tests/glyph-fidelity.browser.test.ts` (create)
- `src/render/tests/fixtures.ts` (create only if shared scene construction materially reduces test
  duplication)
- `src/render/tests/text-pass.browser.test.ts`
- `bench/renderer-benchmark-entry.ts`
- `scripts/renderer-benchmark.ts`
- `docs/renderer-refactor-baseline.md` (create)
- `plans/README.md`

**Out of scope**:

- Changing glyph rasterization, instance layouts, WGSL, draw count, page size, eviction policy, or
  bind groups.
- Public font options or DOM fit behavior.
- Changing CI skips or weakening existing assertions.
- Editing the external platform repository.

## Git workflow

- Work in the current worktree. Do not create a branch or worktree unless the operator requests it.
- Do not commit, push, or open a pull request unless the operator requests it.
- If commits are later requested, use the repository's conventional style, for example
  `test: characterize glyph rendering`.

## Steps

### Step 1: Add atlas and cache diagnostics without behavior changes

Add explicit metrics with unambiguous names:

- CPU atlas page count, cache hits, cache misses, and evictions from `GlyphAtlas`.
- GPU atlas upload bytes and upload operation count from `AtlasGpuTextures`.
- Project those values through `RendererMetrics`; keep existing `uploadedBytes` semantics for
  instance buffers and add `atlasUploadedBytes` rather than silently changing the old field.

Counters must be monotonic for the renderer lifetime and survive metric baselining in the benchmark.
Do not count texture allocation size as uploaded bytes; count bytes passed to `queue.writeTexture`.

**Verify**:
`bun run test:unit -- src/render/atlas/tests/atlas.test.ts` → all tests pass, including new exact
counter assertions for a cache hit, a miss, an upload, and a recycle.

### Step 2: Create one reusable fidelity scene

Create `src/render/tests/glyph-fidelity.browser.test.ts`. Use pixel invariants rather than golden
PNG equality. Cover the current, already-required behavior:

- Latin capitals, lowercase, digits, punctuation, and descenders share a stable baseline within one
  device pixel.
- A Ghostty wide leading cell plus continuation occupies exactly two physical cells and the
  continuation does not allocate a second glyph.
- CJK, a combining sequence, and an emoji produce non-empty coverage without writing outside the
  canvas.
- Default background alpha remains zero and explicit background alpha remains 255.
- Fractional logical DPR inputs produce integer backing-cell dimensions and no row-to-row drift.

Use the readback helpers and `device.pushErrorScope('validation')` pattern from
`src/render/tests/text-pass.browser.test.ts:91-219`. Test DPR by constructing renderer/grid inputs;
do not mutate the browser's global scale factor inside a test.

Do not assert the current full-cell bitmap dimensions as a long-term contract. Plan 003 will replace
them with cropped bounds.

**Verify**:
`bun run test:browser -- src/render/tests/glyph-fidelity.browser.test.ts` → all new cases pass on
the current renderer.

### Step 3: Add a glyph-churn benchmark scenario

Extend the benchmark with a deterministic scenario that repeatedly writes a bounded mix of ASCII,
combining marks, CJK, and emoji. It must exercise atlas cache hits and misses without depending on
random input. Report:

- frame/draw/row/instance-upload metrics;
- atlas hits, misses, pages, evictions, upload operations, and uploaded bytes;
- the existing GPU-process CPU summary.

Keep the four existing scenario names and behavior unchanged so historical comparisons remain
valid.

**Verify**:
`BENCH_WARMUP_SECONDS=1 BENCH_SAMPLE_SECONDS=3 bun run bench:renderer` → five named scenario results,
including `glyph-churn`, with finite non-negative metrics.

### Step 4: Record the immutable baseline

Create `docs/renderer-refactor-baseline.md` with:

- repository commit and date;
- OS, browser version, GPU adapter, viewport, DPR, grid, sample duration;
- all five scenario results from a full `bun run bench:renderer` execution;
- the exact automated test counts from `bun run verify`;
- a note that anti-aliasing pixels are platform-dependent and the tests use geometric invariants.

If a headed hardware adapter is unavailable, record the quick benchmark as diagnostic only, leave
the hardware table explicitly pending, and mark Plan 001 BLOCKED. Do not fabricate or substitute
SwiftShader performance numbers.

**Verify**:
`rg -n "commit|adapter|glyph-churn|atlasUploadedBytes|sample" docs/renderer-refactor-baseline.md`
→ each required evidence category appears.

### Step 5: Run the complete gate and review scope

Run the CI-specific browser launcher in addition to the normal full gate because it uses a
different test partition.

**Verify**:

- `CI=true bun run test:browser` → exit 0.
- `bun run verify` → exit 0.
- `git diff --check` → no output.
- `git status --short` → only in-scope files plus `plans/README.md` are modified.

## Test plan

- Unit tests in `src/render/atlas/tests/atlas.test.ts` for exact cache and upload counters.
- Real-browser geometric tests in `src/render/tests/glyph-fidelity.browser.test.ts`.
- Existing GPU readback tests remain unchanged except for shared helper extraction where needed.
- Benchmark smoke run exercises every scenario; full headed run records the baseline.

## Done criteria

- [ ] `bun run verify` exits 0.
- [ ] `CI=true bun run test:browser` exits 0.
- [ ] Atlas upload bytes are visible separately from instance-buffer bytes.
- [ ] The fidelity scene covers Latin, descenders, punctuation, combining text, CJK, emoji, wide
      continuations, transparency, and fractional DPR.
- [ ] `docs/renderer-refactor-baseline.md` records a real hardware baseline at commit `a7e7372` or
      the actual execution commit before source changes begin.
- [ ] No rendered behavior, shader, draw count, atlas sizing, or public API changed.
- [ ] No out-of-scope files changed.
- [ ] The Plan 001 status row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- The current renderer no longer produces exactly two draws per submitted text frame.
- Existing baseline/fidelity behavior fails before characterization changes.
- Metrics require changing atlas allocation or upload behavior rather than observing it.
- A real headed hardware adapter is unavailable for the full baseline.
- Linux CI fails for a new reason; do not add another skip as part of this plan.
- An in-scope file drifted enough that the excerpts above are no longer true.

## Maintenance notes

- Plans 002–005 must update the baseline metrics intentionally; reviewers should reject unexplained
  metric disappearance or renamed semantics.
- Keep the fidelity test based on bounds and alpha invariants. OS font rasterization makes exact
  screenshot hashes unsuitable for the cross-platform CI gate.
- The glyph-churn scenario is the primary proof for Plan 004's dirty-region upload improvement.
