# Plan 004: Replace monolithic atlases with paged texture arrays

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src/render/atlas src/render/instances src/render/shaders src/render/text-pass.ts src/render/renderer.ts bench scripts docs`
> Plans 001–003 are expected to have changed metrics, tests, pass ownership, and glyph metadata.
> Confirm the live `GlyphBitmap`/`AtlasGlyph` placement contract before editing atlas storage. A
> mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 003 DONE
- **Category**: performance / GPU architecture
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

The current atlas allocates one 2048×2048 CPU page and one GPU texture for each glyph kind. Every
new glyph marks the page dirty, and the next sync uploads the entire page. A one-character miss can
therefore transfer megabytes. The one-page cap also turns capacity pressure into broad generation
recycling and row invalidation.

xterm.js uses multiple atlas pages and page versions so glyph churn does not force a monolithic
rewrite. WebGPU's natural equivalent is a fixed-size two-dimensional texture array: each atlas page
is one layer, glyph instances select a layer, and dirty rectangles update only changed texels. This
plan changes atlas storage and transfer mechanics without changing the glyph pixels established in
Plan 003.

## Current state

- `src/render/atlas/atlas.ts` defaults to 2048×2048 pages, keeps a full CPU `Uint8Array` for every
  page, and caps each atlas kind at one page.
- A page's `consumeUpload()` returns the full backing array whenever any glyph changed.
- At baseline, `src/render/atlas/gpu-textures.ts` owns one RGBA `GPUTexture` per kind and writes a
  full 2D texture on each dirty sync. Plan 003 is expected to have changed the settled prerequisite
  formats to one `r8unorm` grayscale texture and one `rgba8unorm` color texture without changing the
  single-page/full-upload behavior.
- `src/render/text-pass.ts` binds two `texture_2d<f32>` resources and rebuilds atlas bindings when
  texture identity changes.
- `src/render/instances/layout.ts` already carries atlas identity. Plan 003 must have settled the
  actual glyph rectangle and signed placement offsets.
- Plan 001 added explicit atlas upload operations/bytes and a deterministic `glyph-churn` benchmark.
  Those metrics are the acceptance instrument for this plan.

## Target contract

Use one fixed-size texture array for grayscale glyphs and one for color glyphs:

- Default page dimensions: 512×512 device texels with exactly 16 layers per kind. Sixteen 512²
  layers preserve the current 2048² texel capacity per kind while allowing small updates.
- Grayscale layers use `r8unorm`; color layers use `rgba8unorm`. All layers of a kind share format
  and dimensions.
- Layer capacity is bounded by both an explicit renderer/atlas option and
  `device.limits.maxTextureArrayLayers`.
- A glyph's atlas identity is `(kind, layer, generation, x, y, width, height)`.
- Page recycling preserves existing generation-safe row invalidation.
- A glyph insertion reports only its dirty texel rectangle. Multiple unsynced insertions on one
  layer may be coalesced into one bounding rectangle when that sends fewer bytes/operations than
  separate writes.
- Device restoration and layer recycling may upload/clear one full layer. Normal cache misses must
  not upload untouched layers, a full layer, or a full array.
- Texture arrays and bind groups stay stable while layers are filled/recycled. Rebuild them only on
  initial creation, capacity/format change, or device restoration.

The upload boundary must expose enough information for an exact `queue.writeTexture` call:

```ts
export interface AtlasPageUpload {
  bytesPerRow: number
  dataOffset: number
  extent: { height: number; width: number }
  kind: AtlasKind
  layer: number
  origin: { x: number; y: number }
  pixels: Uint8Array
}
```

Equivalent WebGPU-native names are acceptable. `pixels` may reference the persistent full-layer CPU
backing store; `dataOffset` points at the dirty rectangle's first texel and `bytesPerRow` is the
layer stride. This avoids allocating a packed copy for every upload. Metrics count
`extent.width * extent.height * bytesPerTexel`, not the backing array's byte length. Respect WebGPU
row-layout requirements and test odd glyph widths for both one- and four-byte formats.

## Commands you will need

| Purpose                | Command                                                                                                              | Expected on success                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Atlas unit focus       | `bun run test:unit -- src/render/atlas/tests/atlas.test.ts`                                                          | page/layer/dirty-region tests pass           |
| GPU atlas focus        | `bun run test:browser -- src/render/atlas/gpu-textures.browser.test.ts`                                              | texture-array uploads pass validation        |
| Renderer browser focus | `bun run test:browser -- src/render/tests/text-pass.browser.test.ts src/render/tests/glyph-fidelity.browser.test.ts` | pixels and two-draw contract pass            |
| Quick benchmark        | `BENCH_WARMUP_SECONDS=1 BENCH_SAMPLE_SECONDS=3 bun run bench:renderer`                                               | five scenarios and atlas metrics reported    |
| Hardware benchmark     | `bun run bench:renderer`                                                                                             | final five-scenario hardware result recorded |
| CI launcher            | `CI=true bun run test:browser`                                                                                       | supported browser suite passes               |
| Full gate              | `bun run verify`                                                                                                     | all repository gates pass                    |

## Scope

**In scope**:

- `src/render/atlas/types.ts`
- `src/render/atlas/atlas.ts`
- `src/render/atlas/gpu-textures.ts`
- `src/render/atlas/tests/atlas.test.ts`
- `src/render/atlas/gpu-textures.browser.test.ts` (create)
- `src/render/instances/layout.ts`
- `src/render/instances/types.ts`
- `src/render/instances/rows.ts`
- `src/render/instances/tests/rows.test.ts`
- `src/render/shaders/glyph.wgsl.ts`
- `src/render/text-pass.ts`
- `src/render/renderer.ts`
- `src/render/tests/text-pass.browser.test.ts`
- `src/render/tests/glyph-fidelity.browser.test.ts`
- `bench/renderer-benchmark-entry.ts`
- `scripts/renderer-benchmark.ts` only if reporting needs additional fields
- `docs/renderer-refactor-baseline.md`
- `plans/README.md`

**Out of scope**:

- Changing glyph rasterization, crop bounds, bearings, font style identity, cell effects, or public
  font options.
- Color-baking grayscale entries, merging grayscale/color arrays, or changing terminal color
  semantics.
- Variable-sized texture layers, general rectangle defragmentation, background compaction workers,
  or unbounded atlas growth.
- Idle-callback prewarming, timers, a standing render loop, or asynchronous glyph rasterization.
- Reducing draw count by mixing cell and glyph pipelines.

## Git workflow

- Work in the current worktree. Do not create a branch or worktree unless the operator requests it.
- Do not commit, push, or open a pull request unless the operator requests it.
- If commits are later requested, use the repository's conventional style, for example
  `perf: page glyph atlases with dirty uploads`.

## Steps

### Step 1: Specify paging and dirty-region behavior at the CPU boundary

Extend atlas unit tests before changing GPU code. Cover:

- allocation across at least three fixed-size layers;
- separate grayscale and color layer sequences;
- exact layer/origin/extent/data offset/stride/transfer-byte count for one small insertion;
- multiple adjacent insertions coalesced without including other layers;
- multiple distant insertions using the implementation's documented coalescing threshold;
- no upload after `consumeUploads()` until another mutation occurs;
- generation increment and all referencing-row invalidations on recycle;
- cache hit without upload;
- odd-width grayscale and RGBA regions;
- deterministic eviction when the configured 16-layer default or injected test cap is reached.

Make the layer cap injectable in tests. Do not allocate based on current glyph count in production;
the GPU textures need stable layer capacity to avoid bind-group churn.

**Verify**:
`bun run test:unit -- src/render/atlas/tests/atlas.test.ts` → new tests fail only on the old
single-page/full-upload behavior.

### Step 2: Refactor CPU pages around fixed layers and explicit dirty rectangles

Change the atlas default to 512×512 with 16 layers per kind. Validate the requested cap against
`device.limits.maxTextureArrayLayers` before GPU allocation; return a clear structured failure
rather than silently truncating capacity. Rename the internal/test option from `maxPagesPerKind` to
`maxLayersPerKind` and update every call site atomically; do not retain a greenfield compatibility
alias.

Keep a CPU backing array per live layer because device restoration must be able to re-upload it.
Track dirty rectangles per layer. On insertion, union or queue dirty regions according to one
documented bounded rule. On recycle, clear the CPU layer and upload the full 512×512 layer before
new contents can be sampled; stale texels beside a new glyph can otherwise bleed through linear
sampling even after row references are invalidated.

Avoid packed pixel copies in `consumeUploads()`: return a backing-buffer reference, offset, stride,
origin, and extent. Reuse a small bounded region structure where practical, but do not obscure
ownership with a pool until a measurement proves it necessary. Keep all loops flat with `continue`
guard clauses.

Preserve Plan 001 counter semantics. `atlasUploadedBytes` must eventually count actual transfer
bytes, not CPU dirty area estimates.

**Verify**:
`bun run test:unit -- src/render/atlas/tests/atlas.test.ts` → every layer, dirty-region, cache, and
generation case passes.

### Step 3: Implement stable WebGPU texture arrays and partial writes

Allocate one `GPUTexture` per kind with `dimension: '2d'`, its required `r8unorm` or `rgba8unorm`
format, and a `size.depthOrArrayLayers` equal to the validated capacity. Create array views and
change shader bindings from `texture_2d<f32>` to `texture_2d_array<f32>`.

For every upload, call `queue.writeTexture` with the reported data offset/stride, target `origin.z`
layer, and exact 2D origin and extent. Supply correct bytes-per-texel/row behavior for `r8unorm` and
`rgba8unorm`. Do not write other layers and do not recreate texture views/bind groups when a new
layer becomes live.

On device restore, recreate both arrays and upload all live CPU layers. Count those bytes and
operations normally so restoration cost remains observable.

Create a real-browser GPU test that reads back glyphs from at least two layers of each kind and
wraps validation error scopes around allocation, writes, bind-group creation, and drawing.

**Verify**:
`bun run test:browser -- src/render/atlas/gpu-textures.browser.test.ts` → all layer and partial-write
cases pass with no WebGPU validation error.

### Step 4: Carry layer identity through instances and WGSL

Pack the atlas layer as an explicit integer-valued glyph-instance field. Sample with
`textureSample(..., vec3<f32>(uv, layer))` or the WGSL signature required by the existing sampler.
Keep grayscale/color kind selection explicit and preserve texel-center-safe UVs from Plan 003.

Do not use dynamic binding-array features, non-uniform resource indexing, or optional WebGPU
features for two fixed atlas kinds. The texture layer coordinate is data, not a resource index.

Add unit tests that distinguish identical `(x, y)` coordinates in different layers and browser
tests that render them in one frame. The frame must still issue exactly one cell draw and one glyph
draw.

**Verify**:

- `bun run test:unit -- src/render/instances/tests/rows.test.ts` → layer packing assertions pass.
- `bun run test:browser -- src/render/tests/text-pass.browser.test.ts src/render/tests/glyph-fidelity.browser.test.ts`
  → multi-layer rendering, pixels, and exactly-two-draw assertions pass.

### Step 5: Prove transfer reduction and stable bindings

Add exact tests/metrics showing that:

- after initial setup, inserting one small glyph uploads only its dirty rectangle;
- a cache hit uploads zero atlas bytes;
- filling a new layer does not recreate a texture or glyph bind group;
- recycling a layer invalidates referenced rows and performs one explicit full-layer clear upload;
- device restoration recreates resources once and re-uploads every live layer.

Run the quick benchmark first. Then run the full hardware benchmark on the same adapter/configuration
as Plan 001 and append a Plan 004 comparison section to `docs/renderer-refactor-baseline.md`.

The primary acceptance threshold is at least **90% fewer atlas upload bytes** in the deterministic
`glyph-churn` scenario than Plan 001. Existing focused/unfocused/burst/sustained GPU-process CPU must
not regress by more than the larger of **10% relative** or **0.1 percentage point**, comparing
scenario medians. The absolute floor prevents a `0.01%` idle baseline from turning scheduler noise
into a false failure. If noise makes a result inconclusive, repeat the full run three times and
compare run medians; do not relax thresholds in code or hide the result.

**Verify**:

- `BENCH_WARMUP_SECONDS=1 BENCH_SAMPLE_SECONDS=3 bun run bench:renderer` → exact partial-upload
  metrics are finite and non-zero for churn.
- `bun run bench:renderer` → full result satisfies thresholds or triggers a STOP report.

### Step 6: Run the complete gate and review scope

**Verify**:

- `CI=true bun run test:browser` → exit 0 without new skips.
- `bun run verify` → exit 0.
- `git diff --check` → no output.
- `rg -n "texture_2d<" src/render/shaders` → no old glyph atlas 2D bindings; unrelated textures
  must be reviewed rather than mechanically replaced.
- `git status --short` → only in-scope files plus `plans/README.md` are modified.

## Test plan

- CPU atlas tests prove allocation, dirty regions, cache behavior, deterministic recycling, and
  generation-safe row invalidation.
- Real-browser GPU tests prove layer addressing, partial uploads, restoration, and validation.
- Existing fidelity/readback tests prove glyph pixels and cell effects did not change.
- Benchmark evidence proves actual transfer reduction without trading away idle/steady-state CPU.

## Done criteria

- [x] Plan 003 is DONE and its glyph bitmap/placement contract remains unchanged.
- [x] Grayscale and color glyphs use stable fixed-size texture arrays with bounded layer capacity.
- [x] The default is 16 layers per kind; grayscale uses `r8unorm` and color uses `rgba8unorm`.
- [x] Normal glyph misses upload only dirty regions; cache hits upload zero atlas bytes.
- [x] New layers do not recreate textures or glyph bind groups.
- [x] Page recycling remains deterministic and generation-safe.
- [x] Device restoration recreates arrays and restores every live layer.
- [x] `glyph-churn` atlas bytes improve by at least 90% versus Plan 001.
- [x] Existing hardware benchmark medians stay within the larger of 10% relative or 0.1 percentage
      point, or repeated evidence is reviewed and accepted explicitly by the operator.
- [x] A populated frame remains exactly two draws and no standing work is introduced.
- [x] `CI=true bun run test:browser` and `bun run verify` exit 0.
- [x] The Plan 004 status row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- Plan 003 is not DONE or glyph pixels/placement must change to make paging work.
- The target adapter cannot support the validated minimum layer capacity.
- Partial `queue.writeTexture` rows cannot be expressed from the existing persistent layer backing
  via offset/stride and would require per-upload packed copies or a new buffer-staging pipeline;
  report the exact WebGPU constraint before choosing another path.
- Texture or bind-group recreation occurs during ordinary layer growth/recycling.
- Generation-safe row invalidation regresses or a recycled glyph can be sampled for one frame.
- The full hardware benchmark misses the transfer/CPU thresholds after three comparable runs.
- A timer, idle callback, standing loop, third draw, or new CI skip appears necessary.

## Maintenance notes

- Texture array layer capacity is a resource policy. Keep it bounded and explicit; do not grow by
  reallocating arrays during ordinary rendering.
- Dirty CPU bytes and transferred GPU bytes are separate metrics. Acceptance is based on bytes
  passed to `queue.writeTexture`.
- Preserve full live-layer CPU backing for device recovery even when normal uploads use subregions.

## Execution note — 2026-08-24

- CPU atlas focus: 11 tests passed. Row-instance focus: 8 tests passed.
- GPU focus and renderer/fidelity focus: 22 real-browser tests passed, including odd-stride partial
  writes, two layers of both formats, stable views/bindings, recycling, and device restoration.
- Quick glyph churn transferred 1,876,806 bytes versus 717,225,984 bytes after Plan 003.
- Three full hardware runs transferred a median 3,490,357 churn bytes, 99.98207% below Plan 001;
  burst/sustained/unfocused CPU thresholds passed.
- Focused idle repeated at 0.30% versus a 0.20% ceiling even though every renderer activity counter
  remained zero. The operator explicitly accepted this measured variance on 2026-08-24.
- `CI=true bun run test:browser`: 47 renderer/browser tests and both terminal-UI partitions passed.
- `bun run verify`: 130 unit tests and 72 browser tests passed; typecheck, lint, format, and build
  passed.
