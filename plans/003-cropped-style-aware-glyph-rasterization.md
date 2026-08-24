# Plan 003: Rasterize cropped, style-aware glyphs

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src/render/atlas src/render/instances src/render/shaders src/render/tests`
> Plans 001–002 are expected to have changed metrics, tests, and cell/glyph instance ownership.
> Confirm that fixed-cell effects no longer depend on glyph-quad geometry before proceeding. If
> they still do, stop.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 002 DONE
- **Category**: rendering correctness / typography
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

The current rasterizer centers every string into a bitmap exactly one cell high and one or two
cells wide. That makes atlas coordinates simple, but it rescales glyph geometry into the cell
contract and discards the font's actual ink bounds. The result is the failure the operator already
observed: characters in one row can appear to sit at different visual heights, wide glyphs can be
distorted, and italic/bold variants cannot be cached safely.

xterm.js rasterizes into padded scratch space, scans alpha, crops to actual ink, and carries the
crop offset into glyph instances. Implement that behavior with Canvas 2D and WebGPU-native data
structures. Ghostty remains authoritative for cell advance; Canvas measurements determine only the
ink rectangle inside/around that advance.

## Current state

- `src/render/atlas/canvas-rasterizer.ts` computes one baseline from `measureText('Mg')`, then paints
  into a canvas sized `cellWidth * cellSpan` by `cellHeight`.
- Its cache key is only cell span plus text. Bold and italic cells would therefore alias regular
  glyphs if style were added without changing the contract.
- `src/render/atlas/types.ts` exposes `GlyphBitmap.width`, `height`, `advance`, `kind`, and pixels but
  no horizontal or vertical bearing/crop offset.
- `src/render/instances/rows.ts` places the bitmap at the cell origin and sizes the glyph quad from
  the cell span. Plan 002 must have removed cursor/decorative dependence on this rectangle.
- `src/render/atlas/atlas.ts` already carries glyph width/height and generation-safe page identity.
  Preserve that ownership while extending the stored glyph with placement offsets.

## Target contract

Introduce an explicit request and result contract. Names may follow existing conventions, but the
information must be equivalent to:

```ts
export interface GlyphRasterizationInput {
  cellSpan: number
  italic: boolean
  text: string
  weight: 'normal' | 'bold'
}

export interface GlyphBitmap {
  height: number
  kind: AtlasKind
  offsetX: number
  offsetY: number
  pixels: Uint8Array
  width: number
}

export interface GlyphRasterizer {
  rasterize(input: GlyphRasterizationInput): GlyphBitmap | undefined
}
```

`offsetX` and `offsetY` are signed integer device-pixel offsets from the leading cell's top-left to
the cropped bitmap's top-left. The current `advance` field is unused and must be deleted rather than
redefined: Ghostty's requested cell span is the only advance authority and stays on the request/row
side of the boundary. Empty ink such as spaces returns `undefined` instead of allocating a
transparent atlas rectangle.

Rasterization rules:

- Use a stable baseline derived once from the configured font and device-cell height.
- Paint into padded scratch space large enough for italic/bold left, right, ascender, and descender
  overhangs.
- Scan non-zero alpha, crop to the smallest non-empty integer rectangle, and retain its offset.
- For grayscale glyphs, store one coverage byte per pixel (`width * height`). For actual colored
  output, preserve Canvas `ImageData` straight-alpha RGBA pixels (`width * height * 4`) and
  premultiply exactly once in the fragment shader. Classify from the drawn pixels, not an
  `Extended_Pictographic` text regex: a pictograph rendered by a monochrome font belongs in the
  grayscale atlas, while colored canvas output belongs in the color atlas. Kind-specific atlas
  validation must reject any other byte length.
- Use actual cropped width/height for the GPU quad. Never scale the quad to the cell rectangle.
- Cell span and continuation ownership come from Ghostty, not Canvas measurement.
- Apply faint as a glyph alpha multiplier at render time; do not duplicate faint atlas entries.
- Invisible cells and empty-ink glyphs emit no glyph instance.

## Reference behavior

Inspect xterm.js at immutable commit `8938fe37852995761d28c20edb74ee3986e8c438`:

- `TextureAtlas.ts` for padded scratch rasterization, alpha-bound discovery, and glyph offset/size.
- `GlyphRenderer.ts` for constructing an actual-size quad from stored glyph placement.
- `Constants.ts` for style-sensitive cache-key dimensions.

Translate behavior, not code or WebGL texture coordinates. Do not copy source.

## Commands you will need

| Purpose          | Command                                                                                             | Expected on success              |
| ---------------- | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| Atlas unit focus | `bun run test:unit -- src/render/atlas/tests/atlas.test.ts src/render/instances/tests/rows.test.ts` | cache and placement cases pass   |
| Rasterizer focus | `bun run test:browser -- src/render/atlas/canvas-rasterizer.browser.test.ts`                        | cropped bounds/style cases pass  |
| Fidelity focus   | `bun run test:browser -- src/render/tests/glyph-fidelity.browser.test.ts`                           | geometry invariants pass         |
| Text pass focus  | `bun run test:browser -- src/render/tests/text-pass.browser.test.ts`                                | GPU readback cases pass          |
| CI launcher      | `CI=true bun run test:browser`                                                                      | all supported browser tests pass |
| Full gate        | `bun run verify`                                                                                    | all repository gates pass        |

## Scope

**In scope**:

- `src/render/atlas/canvas-rasterizer.ts`
- `src/render/atlas/types.ts`
- `src/render/atlas/atlas.ts`
- `src/render/atlas/gpu-textures.ts`
- `src/render/atlas/tests/atlas.test.ts`
- `src/render/atlas/canvas-rasterizer.browser.test.ts`
- `src/render/instances/layout.ts`
- `src/render/instances/types.ts`
- `src/render/instances/rows.ts`
- `src/render/instances/tests/rows.test.ts`
- `src/render/shaders/glyph.wgsl.ts`
- `src/render/text-pass.ts`
- `src/render/renderer.ts` only where the rasterizer contract is constructed/reset
- `src/render/tests/glyph-fidelity.browser.test.ts`
- `src/render/tests/text-pass.browser.test.ts`
- `plans/README.md`

**Out of scope**:

- Paged texture arrays, dirty-region uploads, atlas page-size changes, sampler changes, or eviction
  redesign; those belong to Plan 004.
- New public font settings, letter spacing, DOM fit changes, or terminal option validation; those
  belong to Plan 005.
- HarfBuzz, cross-cell shaping/ligatures, fallback font selection, grapheme-width correction, or
  custom-drawn box glyphs.
- Rescaling a glyph to make its visible ink fill a cell.
- Rasterizing terminal foreground/background colors into cache entries.

## Git workflow

- Work in the current worktree. Do not create a branch or worktree unless the operator requests it.
- Do not commit, push, or open a pull request unless the operator requests it.
- If commits are later requested, use the repository's conventional style, for example
  `fix: preserve cropped glyph bearings`.

## Steps

### Step 1: Specify cropped bitmap and placement behavior in tests

Replace tests that assert every bitmap equals the cell rectangle with geometric assertions:

- `A`, `a`, digits, punctuation, and descenders use one stable baseline.
- `j` or another overhanging glyph may have a negative `offsetX` without being clipped.
- descenders produce a larger/lower ink bound without moving the shared baseline.
- a space returns no bitmap and causes no atlas allocation.
- regular, bold, italic, and bold-italic requests do not collide in the cache.
- faint reuses the non-faint glyph entry.
- a combining sequence, CJK glyph, width-two emoji, and color emoji keep Ghostty's requested span.
- identical text/style/span requests hit the same cache entry.

Use bounds and alpha coverage, not exact anti-aliased pixels. Pick a deterministic bundled or
platform monospace family already supported by existing tests; do not add a font download.

**Verify**:
`bun run test:browser -- src/render/atlas/canvas-rasterizer.browser.test.ts` → tests expose the old
full-cell/styling limitations before implementation.

### Step 2: Implement padded rasterization and alpha cropping

Refactor the rasterizer into shallow helpers with single responsibilities:

- build the Canvas font string from configured family/size plus request weight/italic;
- calculate scratch dimensions and the stable draw origin;
- identify grayscale versus color output from the rendered pixel channels;
- scan alpha bounds;
- copy the cropped grayscale or RGBA rectangle;
- calculate signed cell-relative offsets.

Allocate or reuse bounded scratch canvases; do not create one DOM canvas per glyph. Clear the exact
scratch region before drawing. Keep dimensions integral in device pixels and reject impossible
zero/negative geometry at construction.

Replace the current Unicode regex classification with bounded pixel inspection after drawing. Since
the configured fill is white, equal non-zero RGB channels are coverage; a non-transparent pixel
with materially different channels indicates actual colored output. Define and test the small
channel tolerance so anti-aliasing noise cannot promote normal text to RGBA storage.

Padding must be derived from cell dimensions and font metrics, not a magic value that only fits the
test font. If Canvas metrics lack a field, use a documented conservative cell-based bound and test
that ink touching a scratch edge is detectable. An edge hit is not permission to crop silently;
either retry with a bounded larger scratch surface or fail with an explicit invariant error.

**Verify**:
`bun run test:browser -- src/render/atlas/canvas-rasterizer.browser.test.ts` → all crop, baseline,
style, space, wide, and color cases pass.

### Step 3: Make atlas identity style- and placement-aware

Key atlas entries by text, Ghostty span, weight, and italic. Use an unambiguous structured key or
length-prefixed encoding; do not concatenate fields with a separator that can occur in text.
Rasterizer recreation on a font change remains the font-identity boundary.

Store `offsetX`/`offsetY` with `AtlasGlyph`. Preserve generation, page kind, page index, UV origin,
and row-reference invalidation exactly. Empty glyphs must not consume a packing rectangle or cache
entry that masquerades as visible coverage. Delete `advance` from the bitmap contract and every
fixture/call site; do not retain an unused compatibility field. Make the CPU atlas page format
kind-specific: one byte per grayscale texel and four bytes per color texel. Update the existing
single-page GPU textures in the same step to `r8unorm` and `rgba8unorm`; do not leave an intermediate
renderer that expands grayscale coverage back to RGBA. Plan 004 changes these settled formats from
single 2D textures to texture arrays.

**Verify**:
`bun run test:unit -- src/render/atlas/tests/atlas.test.ts` → exact hit/miss/allocation assertions
pass for style variants, empty ink, and recycled pages.

### Step 4: Emit actual-size, bearing-aware glyph instances

In `rows.ts`, place each glyph rectangle at:

```text
leading cell device origin + atlas glyph offset
```

and size it from cropped atlas width/height. Keep the cell/continuation advance unchanged. An italic
overhang may extend outside the leading cell; do not clamp it back to the cell or scale it. Row
invalidation must include every row reference already associated with the atlas generation.

Pack bold/italic into the rasterization request, not shader flags. Pack faint as a glyph opacity
value/flag and apply it once in WGSL after choosing grayscale or color glyph output. Invisible and
empty glyphs create no glyph instance.

Use texel-center-safe UVs for the current atlas/sampler. Do not change the sampler in this plan.

**Verify**:

- `bun run test:unit -- src/render/instances/tests/rows.test.ts` → exact signed placement, cropped
  dimensions, faint, invisible, and continuation assertions pass.
- `bun run test:browser -- src/render/tests/text-pass.browser.test.ts` → cropped GPU quads render
  without validation errors or decoration regression.

### Step 5: Strengthen the real-browser fidelity matrix

Update the Plan 001 scene so it verifies the final behavior without platform-specific snapshots:

- all glyphs in a row share a baseline within one device pixel;
- uppercase/lowercase/descender ink heights may differ but their placement is stable;
- overhangs remain visible;
- regular/bold/italic/bold-italic are visually non-empty and separately cached;
- faint has lower alpha/coverage contribution than regular;
- invisible and spaces leave background/cell effects intact while contributing no glyph pixels;
- CJK, combining sequences, and emoji retain expected one- or two-cell advances;
- decorations/cursors remain fixed to cells after glyph cropping;
- populated frames remain exactly two draws.

**Verify**:
`bun run test:browser -- src/render/tests/glyph-fidelity.browser.test.ts src/render/tests/text-pass.browser.test.ts`
→ all cases pass.

### Step 6: Run the complete gate and review scope

**Verify**:

- `CI=true bun run test:browser` → exit 0 without new skips.
- `bun run verify` → exit 0.
- `git diff --check` → no output.
- `git status --short` → only in-scope files plus `plans/README.md` are modified.
- Run the Plan 001 quick benchmark. Record the comparison in the plan execution note, but do not
  tune atlas storage here; upload reduction belongs to Plan 004.

## Test plan

- Canvas browser tests prove baseline, crop bounds, overhangs, style identity, empty ink, Unicode,
  and grayscale/color classification.
- Atlas unit tests prove cache identity and generation-safe placement metadata.
- Row unit tests prove signed glyph positioning and unchanged Ghostty advance.
- GPU readback proves actual-size quads, cell-effect separation, faint/invisible behavior, and two
  draws.

## Done criteria

- [x] Plan 002 is DONE and fixed-cell effects do not depend on glyph-quad dimensions.
- [x] Glyph bitmaps contain signed cell-relative offsets and actual cropped dimensions.
- [x] The unused Canvas `advance` field is removed; Ghostty span remains the sole advance authority.
- [x] Grayscale bitmaps/pages use one coverage byte per texel and color bitmaps/pages use four RGBA
      bytes per texel.
- [x] The prerequisite single-page GPU path uses `r8unorm` for grayscale and `rgba8unorm` for color,
      with premultiplication performed exactly once in the glyph fragment shader.
- [x] Spaces/empty ink allocate no atlas rectangle and emit no glyph instance.
- [x] Regular, bold, italic, and bold-italic cache entries cannot collide; faint reuses coverage.
- [x] Glyph quads use actual bitmap size and are never stretched to the cell rectangle.
- [x] Ghostty remains authoritative for one- and two-cell advances.
- [x] Latin baseline, descender, overhang, combining, CJK, emoji, faint, invisible, and style cases
      pass real-browser tests.
- [x] A populated frame remains exactly two draws.
- [x] `CI=true bun run test:browser` and `bun run verify` exit 0.
- [x] The Plan 003 status row in `plans/README.md` is `DONE`.

## Execution note — 2026-08-24

- `CI=true bun run test:browser`: 44 hardware tests passed; both browser-mode partitions passed
  without new skips.
- `bun run verify`: 123 unit tests and 69 browser tests passed; typecheck, lint, format, and build
  passed.
- The quick benchmark (`1s` warmup, `3s` sample) completed on Apple Metal. Glyph churn measured a
  `10.1%` median GPU-process CPU and `717,225,984` atlas-upload bytes across 171 operations. This is
  diagnostic only: Plan 004 owns the upload reduction.

## STOP conditions

Stop and report if:

- Plan 002 is not DONE or any cell effect still uses glyph-quad coverage.
- Alpha cropping would require changing Ghostty's cell width or continuation semantics.
- A required Canvas font metric is unavailable and the proposed fallback can still clip ink at the
  bounded scratch edge.
- Correct overhang placement requires cross-row shaping or neighbor-cell knowledge.
- Generation-safe atlas recycling or row invalidation regresses.
- Linux CI needs a new skip or exact anti-aliasing snapshots become necessary.

## Maintenance notes

- Keep crop offsets signed through every layer. Converting them to unsigned texture coordinates is
  a common source of left/top clipping.
- A glyph's visible dimensions and its terminal advance are different concepts. Do not merge them
  when simplifying types later.
- Plan 004 consumes this settled bitmap contract and may change only storage/upload mechanics, not
  rasterization geometry.
