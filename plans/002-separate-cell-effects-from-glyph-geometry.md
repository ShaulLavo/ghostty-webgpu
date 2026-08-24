# Plan 002: Separate cell effects from glyph geometry

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src/render`
> Plan 001 is expected to have changed renderer metrics and test infrastructure. If the live
> instance or shader contracts differ from the excerpts below, update this plan before editing
> production code. A semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 001 DONE
- **Category**: architecture / rendering correctness
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

The current glyph instance and glyph shader own two unrelated geometries: variable text coverage
and fixed-cell effects such as underline, strike-through, cursor, and minimum-contrast background.
That only works while every glyph quad is the full cell rectangle. It prevents Plan 003 from using
alpha-cropped, bearing-aware glyph quads because decorations and cursors would then shrink or move
with the character bitmap.

xterm.js separates fixed background/cursor rectangles from actual-size glyph quads. Adapt that seam
to this renderer's recolorable atlas: the first instanced draw handles all fixed-cell pixels,
including decorations, and the second handles glyph texture coverage only. This retains the
renderer’s stronger two-draw contract without baking terminal colors into glyph cache entries.

## Current state

- `src/render/instances/layout.ts` defines an 8-float background instance and a 24-float glyph
  instance. `GlyphOffset` includes rectangle, colors, UVs, cell background, metadata, and atlas
  identity in one record.
- `src/render/instances/rows.ts` emits a fixed-cell background rectangle, then emits one glyph
  rectangle whose flags also encode underline, undercurl, strike-through, overline, cursor shape,
  invisible, minimum contrast, and other cell state.
- `src/render/shaders/glyph.wgsl.ts` samples the atlas and computes decoration/cursor coverage over
  the same quad. The shader therefore assumes the glyph rectangle is a cell rectangle.
- `src/render/shaders/background.wgsl.ts` only fills a rectangle with one premultiplied color.
- `src/render/text-pass.ts` already issues exactly two instanced draws. Preserve that architecture;
  this plan redistributes work between the existing draws and must not add a third pass.
- Continuation cells intentionally skip glyph rasterization. They still need their own fixed-cell
  background, selection, decoration, and cursor behavior.

## Target contract

Rename the conceptual background pass to the **cell pass** and give it enough per-instance data to
render all fixed-cell effects:

```ts
export const CELL_INSTANCE_FLOATS = 16

export const CellOffset = {
  rect: 0, // x, y, width, height in device pixels
  foreground: 4, // premultiplied decoration/cursor color
  background: 8, // premultiplied cell background
  metadata: 12, // flags, underline style, cursor style, minimum contrast
} as const
```

The exact packing may change only if it remains 16 floats or fewer and every field has a named
offset. Do not use bit reinterpretation between `u32` and `f32`; the current buffer is a float
storage buffer and explicit integer-valued flags are sufficient.

The glyph instance becomes text-only. It may still carry foreground, background, and minimum
contrast if the glyph shader needs them for final color selection, but it must not carry or render
cursor/decorative coverage. Plan 003 may then change its rectangle independently.

The cell shader must composite, in this order, using premultiplied alpha:

1. explicit cell/selection/inverse background;
2. underline styles `1..5` from the pinned Ghostty `GhosttySgrUnderline` contract — single,
   double, curly, dotted, and dashed — plus strike-through and overline;
3. cursor shape coverage for block, bar, underline, and outline cursors.

Preserve the current block-cursor foreground/background swap. The glyph shader must still select
the correct foreground when a block cursor occupies the cell, but the block rectangle itself is
cell-pass coverage. Do not infer continuation or cursor state in WGSL; encode resolved state from
Ghostty's cell model in `rows.ts`.

## Commands you will need

| Purpose             | Command                                                                   | Expected on success                                    |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Instance unit focus | `bun run test:unit -- src/render/instances/tests/rows.test.ts`            | all row packing assertions pass                        |
| Browser cell focus  | `bun run test:browser -- src/render/tests/text-pass.browser.test.ts`      | all cell/glyph readback tests pass                     |
| Fidelity scene      | `bun run test:browser -- src/render/tests/glyph-fidelity.browser.test.ts` | Plan 001 invariants pass                               |
| CI launcher         | `CI=true bun run test:browser`                                            | all supported browser tests pass                       |
| Full gate           | `bun run verify`                                                          | typecheck, lint, format, unit, browser, build all pass |

## Scope

**In scope**:

- `src/render/instances/layout.ts`
- `src/render/instances/types.ts`
- `src/render/instances/rows.ts`
- `src/render/instances/tests/rows.test.ts`
- `src/render/shaders/background.wgsl.ts` (replace with `cell.wgsl.ts` and delete the old file)
- `src/render/shaders/glyph.wgsl.ts`
- `src/render/text-pass.ts`
- `src/render/tests/text-pass.browser.test.ts`
- `src/render/tests/glyph-fidelity.browser.test.ts`
- `plans/README.md`

**Out of scope**:

- Changing canvas glyph rasterization, bitmap bounds, atlas page storage, texture dimensionality,
  sampler policy, font options, DOM fit, public exports, or benchmark scenarios.
- Adding a third draw, render pass, offscreen target, or per-cell draw call.
- Reinterpreting Ghostty continuation width or synthesizing styles not present in render state.
- Moving shaping, font fallback, custom-glyph drawing, or ligatures into this phase.

## Git workflow

- Work in the current worktree. Do not create a branch or worktree unless the operator requests it.
- Do not commit, push, or open a pull request unless the operator requests it.
- If commits are later requested, use the repository's conventional style, for example
  `refactor: separate cell and glyph geometry`.

## Steps

### Step 1: Freeze the instance contracts in unit tests

Before changing shaders, extend `src/render/instances/tests/rows.test.ts` to assert separate cell and
glyph records for these cases:

- a normal transparent cell;
- explicit background plus foreground glyph;
- leading and continuation cells for a width-two glyph;
- each underline family member, strike-through, and overline;
- block, bar, underline, and outline cursor shapes;
- selection/inverse and minimum-contrast inputs;
- invisible text, which still emits required cell effects but emits no visible glyph coverage.

Assert named fields and flags, not a single opaque `Float32Array` snapshot. Assert the exact cell and
glyph instance counts, especially that continuation cells never create duplicate glyph instances.

**Verify**:
`bun run test:unit -- src/render/instances/tests/rows.test.ts` → new expectations fail only where
the old combined record lacks the proposed separation.

### Step 2: Introduce the cell instance layout and row packing

Replace background terminology in instance code with cell terminology. Build one fixed rectangle
per drawable Ghostty cell and resolve its background, decoration, cursor, selection, inverse, and
minimum-contrast inputs there. Keep row-cache ownership and damage accounting unchanged.

Use named packing helpers small enough to keep nesting at three levels or less. Prefer early returns
for continuation and invisible glyph decisions. Do not hide cell policy in a generic array writer.

Update row byte accounting to use the new instance stride. Plan 001's metrics must continue to
report exact uploaded instance bytes after the stride change.

**Verify**:
`bun run test:unit -- src/render/instances/tests/rows.test.ts` → all row packing and byte-count tests
pass.

### Step 3: Replace the background shader with the cell shader

Create `src/render/shaders/cell.wgsl.ts` and delete `background.wgsl.ts`. Move decoration and cursor
coverage functions out of the glyph shader. Use device-pixel coordinates derived from the cell
quad, so a one-pixel line stays one backing pixel at fractional logical DPR.

Return premultiplied color from the cell fragment shader. A transparent undecorated default cell
must produce zero alpha; do not paint a black fallback. Preserve all current line styles and cursor
shapes pixel-for-pixel within the one-device-pixel tolerance already used by browser tests. Add the
currently collapsed double, dotted, and dashed underline distinctions using Ghostty's pinned numeric
values; do not invent a second underline enum. Every line/wave/dot/dash thickness must be at least
one integer device pixel.

Keep shader control flow shallow. Extract WGSL helpers for coverage rather than nesting style and
cursor branches inside the fragment entry point.

**Verify**:
`bun run test:browser -- src/render/tests/text-pass.browser.test.ts` → cell effects, transparency,
selection, inverse, cursor, and minimum-contrast cases pass.

### Step 4: Reduce the glyph shader to glyph concerns

Remove decoration/cursor coverage from `glyph.wgsl.ts`. Its fragment stage must:

- sample grayscale or color glyph coverage;
- choose the resolved foreground, including the existing block-cursor color swap;
- apply minimum contrast using the cell background input;
- emit premultiplied glyph color.

Do not crop or reposition glyph quads in this plan. Preserve the current full-cell rasterizer and UV
contract so any pixel change is attributable to the pass split, not two refactors at once.

**Verify**:
`bun run test:browser -- src/render/tests/glyph-fidelity.browser.test.ts` → Plan 001 geometry and
alpha invariants pass.

### Step 5: Update the text pass without increasing draw count

Rename buffers, pipelines, shader imports, and metrics from background to cell where those names are
internal. Keep one cell pipeline draw followed by one glyph pipeline draw in the same render pass.
Empty instance ranges may skip their draw exactly as they do today, but a populated text frame must
still report exactly two draws.

Do not rebuild atlas bind groups merely because cell data changed. Do not change atlas texture or
sampler bindings in this plan.

Add browser coverage for decorations on spaces and continuation cells, because those are the cases
most likely to disappear when effects are no longer attached to glyph coverage.

**Verify**:

- `bun run test:browser -- src/render/tests/text-pass.browser.test.ts` → all cases pass and the
  populated-path assertion reports exactly two draws.
- `bun run test:browser -- src/render/tests/glyph-fidelity.browser.test.ts` → all cases pass.

### Step 6: Run the complete gate and review scope

**Verify**:

- `CI=true bun run test:browser` → exit 0 without new skips.
- `bun run verify` → exit 0.
- `git diff --check` → no output.
- `rg -n "background\.wgsl|BackgroundOffset|BACKGROUND_INSTANCE" src/render` → no stale internal
  background-pass names; ordinary cell background color names are allowed.
- `git status --short` → only in-scope files plus `plans/README.md` are modified.

## Test plan

- Unit tests prove cell/glyph instance counts and named field packing for normal, wide, decorated,
  selected, inverse, cursor, and invisible cells.
- Real-browser readback proves cell shader coverage and premultiplied transparency.
- The Plan 001 fidelity scene proves no baseline, wide-cell, or DPR drift.
- Existing exact-two-draw assertions guard the performance architecture.

## Done criteria

- [ ] Plan 001 is DONE and its baseline exists.
- [ ] Every fixed-cell effect is generated by the cell pass, including on spaces and continuation
      cells.
- [ ] Ghostty underline values 1–5 render as distinct single, double, curly, dotted, and dashed
      fixed-cell effects.
- [ ] The glyph shader contains no decoration or cursor shape coverage.
- [ ] A populated text frame still uses exactly two instanced draws.
- [ ] Default background alpha, explicit background, selection, inverse, minimum contrast, cursor,
      and decoration behavior pass real-browser tests.
- [ ] Glyph rasterization and atlas storage behavior did not change.
- [ ] `CI=true bun run test:browser` and `bun run verify` exit 0.
- [ ] The Plan 002 status row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- Plan 001 is not DONE or its characterization tests are red before this work begins.
- Correct fixed-cell effects require a third draw or a per-cell draw call.
- A decoration/cursor behavior cannot be derived from existing Ghostty render state.
- The split changes glyph bitmap dimensions, atlas allocation, or sampler behavior.
- Existing selection, inverse, minimum-contrast, or block-cursor color semantics are ambiguous; do
  not silently choose a new policy.
- Linux CI needs a new skip.

## Maintenance notes

- Plan 003 relies on the invariant that a glyph quad may shrink or overhang without changing any
  cell effect.
- Keep cell geometry expressed in integer device pixels. DOM/CSS geometry remains outside this
  layer.
- If a future feature needs another cell-local effect, prefer extending the cell-pass metadata over
  coupling it back to the glyph bitmap.
