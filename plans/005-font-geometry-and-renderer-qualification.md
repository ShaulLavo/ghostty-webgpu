# Plan 005: Integrate font geometry and requalify the renderer

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src/dom src/term src/render bench scripts README.md docs`
> Plans 001–004 are expected to have substantially changed the renderer and tests. Confirm their
> status rows are DONE and compare every current public type/function named below with the live code
> before editing. A contract mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 004 DONE
- **Category**: integration / public API / qualification
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

Plans 002–004 fix the internal rendering architecture, but the font metrics still enter through
separate paths: DOM fit measures a CSS canvas, the renderer accepts only family/size, and terminal
options expose family/line-height/size. A renderer can be internally correct and still drift if CSS
cell geometry, device backing geometry, the rasterizer baseline, pointer projection, and Ghostty's
grid do not share one canonical device-pixel result.

This final plan makes that contract explicit, adds the small style options required by the new
rasterizer, qualifies fractional DPR and resize behavior, and records final benchmark/test evidence.
It closes the automated renderer refactor only. It must not claim that the physical Phase 3 operator
gate has passed.

## Current state

- `src/term/types.ts` defines font family, line height, and size only.
- `src/term/session.ts` defaults to `monospace`, line height `1.2`, and size `14`, and normalizes only
  those values.
- `src/dom/fit.ts` measures `M` for cell width, multiplies font size by line height for height, then
  normalizes to integer device-cell geometry and derives CSS dimensions.
- `src/dom/types.ts` exposes renderer `setFont(fontFamily, fontSize)` rather than one stable font
  contract.
- `src/render/renderer.ts` recreates/reset rasterization state when family, size, grid, or device
  changes. Plans 003–004 must have preserved this lifecycle while adding glyph metrics/pages.
- The benchmark already checks exact two-draw behavior, idle behavior, and renderer metrics. Plans
  001 and 004 added glyph churn and atlas transfer comparisons.
- Phase 3 acceptance documentation still requires a physical operator gate for input, IME,
  clipboard, focus, and VoiceOver. Automated green status cannot replace that evidence.

## Target contract

Extend `TerminalFontSettings` with these renderer-relevant options:

```ts
export interface TerminalFontSettings {
  boldWeight: number
  family: string
  letterSpacing: number
  lineHeight: number
  size: number
  weight: number
}
```

Defaults:

- `family: 'monospace'`
- `size: 14`
- `lineHeight: 1.2`
- `letterSpacing: 0`
- `weight: 400`
- `boldWeight: 700`

Weights are finite integers in Canvas/CSS's numeric `1..1000` range. Letter spacing is a finite CSS
pixel value and may be negative only while the normalized device cell width remains positive. Line
height is finite and at least `1`, matching the geometry invariant that a cell cannot be shorter
than its character box. Keep validation in the existing terminal option normalization boundary; do
not create a parallel renderer settings system.

Introduce one immutable fitted-font result passed through DOM integration to the renderer. It must
contain, directly or through clearly named nested values:

- normalized font settings;
- integer device character width and height;
- integer device cell width and height;
- integer character left/top offsets inside the cell;
- device-pixel baseline/draw origin needed by the rasterizer;
- derived CSS cell width/height;
- effective DPR used for conversion.

Character ink geometry and cell geometry are distinct. Following xterm's proven rule, derive them
once in device pixels:

```text
deviceCharWidth  = floor(measured CSS advance × DPR)
deviceCharHeight = ceil(measured CSS font height × DPR)
deviceSpacing    = round(letterSpacing × DPR)
deviceCellWidth  = deviceCharWidth + deviceSpacing
deviceCellHeight = floor(deviceCharHeight × lineHeight)
charLeft         = floor(deviceSpacing / 2)
charTop          = lineHeight == 1 ? 0 : round((deviceCellHeight - deviceCharHeight) / 2)
```

Reject a result unless all character/cell dimensions are positive safe integers. CSS cell sizes,
canvas backing dimensions, terminal rows/columns, pointer projection, and glyph placement derive
from the device cell. No downstream layer independently rounds the same font measurement a second
time.

Replace positional `setFont(fontFamily, fontSize)` with one named object contract. This repository is
greenfield: update every call site in the same pass; do not add a deprecated overload.

Make the low-level renderer boundary unambiguous as well:

- `WebGpuTerminalRendererOptions` requires the fitted-font value instead of separate
  `cellHeight`/`cellWidth`/`pixelRatio`/`fontFamily`/`fontSize` fields.
- Renderer construction still receives `columns` and `rows`; those are grid occupancy, not font
  geometry.
- Renderer `resize` accepts only changed `columns`/`rows`. Font/DPR/cell geometry changes arrive
  through `setFont(fittedFont)`.
- Direct low-level renderer consumers must provide a fitted value. Do not synthesize a second
  measurement path inside `src/render`.

`TerminalFitResult` must carry this fitted-font value. `handleAppearance` sends raw normalized font
settings only to the fit controller; it must not push an independently measured font into the
renderer. `applyFit` applies the fitted font to the renderer before resizing the session/grid. The
renderer updates its stored device-cell geometry during `setFont`, so the following `resize` changes
rows/columns without a second rasterizer/atlas reset when the dimensions are identical.

## Reference behavior

Inspect xterm.js at immutable commit `8938fe37852995761d28c20edb74ee3986e8c438`:

- `WebglRenderer.ts` for integer device dimensions with CSS dimensions derived afterward.
- `TextureAtlas.ts` for stable baseline/origin and font weight/italic construction.

Use the geometry principles only. This package is not an xterm.js API implementation, and option
names/types should fit its existing terminal session API.

## Commands you will need

| Purpose             | Command                                                                                                              | Expected on success                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Terminal unit focus | `bun run test:unit -- src/term/tests/session.test.ts`                                                                | option normalization/defaults pass          |
| DOM unit focus      | `bun run test:unit -- src/dom/tests/fit.test.ts`                                                                     | canonical geometry cases pass               |
| Rasterizer focus    | `bun run test:browser -- src/render/atlas/canvas-rasterizer.browser.test.ts`                                         | fitted font/style cases pass                |
| Fidelity matrix     | `bun run test:browser -- src/render/tests/glyph-fidelity.browser.test.ts src/render/tests/text-pass.browser.test.ts` | DPR/style/pixel cases pass                  |
| Benchmark smoke     | `BENCH_WARMUP_SECONDS=1 BENCH_SAMPLE_SECONDS=3 bun run bench:renderer`                                               | five scenarios pass thresholds structurally |
| Hardware benchmark  | `bun run bench:renderer`                                                                                             | final evidence recorded                     |
| CI launcher         | `CI=true bun run test:browser`                                                                                       | supported browser suite passes              |
| Full gate           | `bun run verify`                                                                                                     | all repository gates pass                   |

If a listed existing test filename moved during Plans 001–004, use its exact live replacement and
record the substitution in this plan's execution notes; do not create a duplicate test directory.

## Scope

**In scope**:

- `src/term/types.ts`
- `src/term/session.ts`
- `src/term/tests/session.test.ts`
- `src/dom/fit.ts`
- `src/dom/tests/fit.test.ts` (create for injected pure geometry coverage)
- `src/dom/types.ts`
- `src/dom/terminal.ts`
- `src/dom/tests/terminal-input.browser.test.ts`
- `src/dom/tests/terminal-ui.browser.test.ts`
- `src/dom/tests/pointer-selection.browser.test.ts`
- `src/render/renderer.ts`
- `src/render/atlas/canvas-rasterizer.ts`
- `src/render/atlas/canvas-rasterizer.browser.test.ts`
- `src/render/tests/glyph-fidelity.browser.test.ts`
- `src/render/tests/renderer.browser.test.ts`
- `src/render/tests/text-pass.browser.test.ts`
- `src/index.ts`
- `bench/renderer-benchmark-entry.ts`
- `scripts/renderer-benchmark.ts`
- `README.md`
- `docs/renderer-refactor-baseline.md`
- `docs/phase-3-acceptance.md`; update automated evidence only
- `plans/README.md`

**Out of scope**:

- Claiming or performing the physical operator gate on behalf of the operator.
- xterm.js constructor/options/event/API compatibility or a drop-in replacement claim.
- HarfBuzz shaping, ligatures, fallback font chains, font loading/download APIs, custom glyphs, or
  image protocols.
- Changing Ghostty's width/continuation decisions.
- Adding another persistent setting store, environment variable, or backward-compatibility overload.
- Relaxing benchmark thresholds, browser assertions, CI skips, or the no-standing-work contract.

## Git workflow

- Work in the current worktree. Do not create a branch or worktree unless the operator requests it.
- Do not commit, push, or open a pull request unless the operator requests it.
- If commits are later requested, use the repository's conventional style, for example
  `feat: unify terminal font geometry`.

## Steps

### Step 1: Extend and validate the terminal font settings contract

Add `weight`, `boldWeight`, and `letterSpacing` to defaults, input typing, normalization, equality,
and change detection. Tighten line height to finite `>= 1`. Reject non-finite values,
out-of-range/non-integer weights, and any fitted letter spacing that produces non-positive device
width.

Decide at the existing option boundary whether invalid partial options throw or normalize based on
current session behavior; preserve that policy consistently. Do not silently reinterpret strings as
numeric weights unless the existing public type already promises strings.

Test defaults, valid partial updates, lower/upper weight boundaries, invalid weights, positive and
negative letter spacing, and font-change invalidation. Assert no redundant renderer reset when the
normalized settings are unchanged.

**Verify**:
`bun run test:unit -- src/term/tests/session.test.ts` → all font default/validation/change cases pass.

### Step 2: Produce one canonical fitted-font geometry result

Refactor `src/dom/fit.ts` so one function performs font measurement and device normalization. Add
letter spacing through the target `deviceSpacing`/`deviceCellWidth` formula after the character
advance has been floored to its integer device width. Derive CSS cell width/height from the integer
device dimensions and effective DPR; never round CSS and device values independently.

Calculate the rasterizer's stable baseline/draw origin in the same measurement operation or from the
same immutable metrics. Do not let the renderer call `measureText('M')` and derive a competing
character or cell width. Font ink metrics may influence scratch/baseline placement but must not
override Ghostty's fitted cell advance.

Expose one DOM-owned font-fitting helper used by both initial renderer creation and
`TerminalFitController`; the low-level renderer must never call `measureText`. This allows
`createRenderer` to receive a coherent fitted value before the controller's first animation-frame
fit. If the container is not yet measurable, font fitting still succeeds and the existing session
row/column defaults remain until a later container fit.

Test at DPR `1`, `1.25`, `1.5`, `2`, and `2.2` with multiple font sizes, line heights, and letter
spacing values. For each case assert:

- device width/height are positive integers;
- CSS × DPR maps back to the same device dimensions within floating-point tolerance;
- N columns/rows produce no cumulative row or column drift;
- pointer projection at the first/last pixel resolves to the expected cell;
- repeated fit with identical inputs is stable.

Use injected measurement values for pure unit tests. Keep real Canvas/font behavior in browser tests.

**Verify**:
`bun run test:unit -- src/dom/tests/fit.test.ts` → all canonical geometry/DPR/projection cases pass.

### Step 3: Replace positional renderer font mutation with the fitted object

Update `src/dom/types.ts`, `src/dom/terminal.ts`, renderer construction, resize, option updates, and
tests to pass one named fitted-font object. Delete the positional overload and the redundant
low-level renderer option fields, then update all imports/call sites in one pass. Route raw
appearance font updates to `TerminalFitController.setFont`; route only the resulting fitted value
from `applyFit` to renderer `setFont`, before `session.resize` publishes the matching grid. Project
the subsequent renderer `resize` call down to columns/rows only.

The renderer must recreate glyph rasterization/atlas state exactly once when family, size, weight,
bold weight, letter spacing, baseline, or integer device-cell dimensions change. The immediately
following resize with those same device dimensions may change rows/columns/canvas size but must not
reset the atlas again. A CSS-only container resize that leaves fitted font geometry unchanged must
not reset the atlas.

Preserve generation invalidation and device-restoration ownership from Plans 003–004. Do not reset
the atlas once per animation frame or pointer event.

**Verify**:

- `rg -n "setFont\(" src` → every call uses the named object; no positional compatibility overload.
- `rg -n "fontFamily\?|fontSize\?|cellHeight: grid\.cellHeight|pixelRatio: grid\.pixelRatio" src/dom src/render`
  → no redundant low-level renderer font/geometry inputs remain.
- Focused terminal/DOM/renderer tests prove one reset for a real font change and zero for an
  equivalent normalized update.

### Step 4: Wire weight, bold weight, italic, and letter spacing into rasterization

Use regular/bold numeric weights from the fitted settings when building the Canvas font string. Keep
italic driven by Ghostty cell style. Letter spacing changes device cell advance and the fitted
`charLeft`; it must not set Canvas `letterSpacing`, split a grapheme/combining sequence, or insert
spacing inside a cell-local string. Do not use different cell widths for regular versus bold/italic.

Extend real-browser fidelity tests for regular, bold, italic, bold-italic, positive letter spacing,
safe negative letter spacing, and all target DPRs. Use baseline/bounds/coverage assertions, not
pixel-perfect anti-aliasing snapshots.

**Verify**:
`bun run test:browser -- src/render/atlas/canvas-rasterizer.browser.test.ts src/render/tests/glyph-fidelity.browser.test.ts src/render/tests/text-pass.browser.test.ts`
→ style, spacing, DPR, transparency, decorations, and exact-two-draw cases pass.

### Step 5: Requalify performance and scheduling

Run the quick benchmark to catch structural failures, then the full hardware benchmark using the
same adapter, browser mode, viewport, DPR, grid, warmup, and sample duration recorded by Plan 001.
Append final results to `docs/renderer-refactor-baseline.md` rather than overwriting prior evidence.

Acceptance:

- exactly two draws for populated frames;
- zero standing render loop/timer and the existing unfocused-idle behavior preserved;
- Plan 004's at-least-90% glyph-churn atlas-byte reduction remains intact;
- focused, unfocused, burst, and sustained GPU-process CPU medians regress by no more than the
  larger of 10% relative or 0.1 percentage point versus Plan 001;
- no unbounded growth in atlas layers, glyph cache, submitted frames, or row rebuilds during the
  fixed-duration scenarios.

If a CPU comparison is noisy, repeat three full runs and report medians. Do not compare a hardware
result to SwiftShader or a quick diagnostic run.

**Verify**:

- `BENCH_WARMUP_SECONDS=1 BENCH_SAMPLE_SECONDS=3 bun run bench:renderer` → all five scenarios
  complete with finite metrics.
- `bun run bench:renderer` → final hardware evidence meets thresholds or triggers a STOP report.

### Step 6: Update public documentation without overstating compatibility

Update `README.md` and relevant docs to describe:

- the renderer's cell pass + cropped glyph pass architecture;
- style-aware, bearing-aware rasterization;
- paged WebGPU texture-array atlases and dirty-region uploads;
- supported font settings and their defaults;
- the canonical device-pixel geometry rule;
- current automated test/benchmark evidence.

Explicitly state that `ghostty-webgpu` is **not an xterm.js drop-in replacement** unless a separate
compatibility layer is later implemented. It borrows proven renderer architecture while using
Ghostty's terminal model and its own API.

In the existing Phase 3 acceptance document, update automated test counts and link/quote the final
benchmark evidence. Leave every physical-only item `PENDING` until the operator actually performs
it. Do not mark Phase 3 or the operator gate PASS in this plan.

**Verify**:

- `rg -n "drop-in|texture array|letterSpacing|PENDING|operator" README.md docs` → compatibility,
  architecture, font settings, and manual-gate status are documented.
- Review the actual wording to ensure no automated result is presented as physical evidence.

### Step 7: Run the complete gate and prepare the physical gate

Load the corrected build in the already-running headed demo; do not start another dev server. Verify
that the page loads without console/WebGPU validation errors and that the final fidelity scene is
visually coherent. This is a readiness check, not the physical operator gate.

**Verify**:

- `CI=true bun run test:browser` → exit 0 without new skips.
- `bun run verify` → exit 0.
- `git diff --check` → no output.
- `git status --short` → only in-scope files plus `plans/README.md` are modified.
- The headed demo uses the current build and is ready for the documented operator checklist.

After automated completion, report: “Renderer refactor automated qualification complete; physical
Phase 3 operator gate still pending.” Do not proceed to manual input/IME/clipboard/VoiceOver claims
without the operator.

## Test plan

- Terminal unit tests cover font option defaults, validation, equality, and invalidation.
- DOM unit tests cover canonical device/CSS geometry, fractional DPR, accumulated drift, and pointer
  projection.
- Browser rasterizer/fidelity tests cover style, spacing, baseline, bounds, Unicode, decorations,
  transparency, and exact two draws.
- Full hardware benchmarks compare the unchanged Plan 001 scenarios plus glyph churn.
- Documentation review preserves the automated-versus-physical evidence boundary.

## Done criteria

- [x] Plans 001–004 are DONE.
- [x] Font settings expose validated weight, bold weight, and letter spacing with documented defaults.
- [x] One immutable fitted-font result owns integer device geometry, CSS derivation, and rasterizer
      baseline inputs.
- [x] Device character and cell dimensions remain distinct; line height/letter spacing become
      integer `charTop`/`charLeft` placement rather than bitmap scaling or grapheme splitting.
- [x] Every positional `setFont(family, size)` call/overload is removed.
- [x] Renderer construction accepts one fitted font plus rows/columns; renderer `resize` no longer
      re-normalizes font/DPR/cell geometry.
- [x] DPR `1`, `1.25`, `1.5`, `2`, and `2.2` pass no-drift unit/browser coverage.
- [x] Final fidelity tests cover all supported font styles, Unicode classes, transparency, cell
      effects, and actual glyph placement.
- [x] Final hardware benchmarks preserve Plan 004 upload improvement and stay within CPU thresholds.
- [x] A populated frame remains exactly two draws and idle scheduling remains event-driven.
- [x] README/docs explicitly avoid claiming xterm.js drop-in compatibility.
- [x] Physical Phase 3 items remain PENDING and the headed demo is ready for the operator.
- [x] `CI=true bun run test:browser` and `bun run verify` exit 0.
- [x] The Plan 005 status row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- Any prerequisite plan is not DONE.
- DOM fit, renderer rasterization, and pointer projection cannot consume one canonical device grid
  without changing Ghostty's terminal dimensions.
- A requested font option needs cross-cell shaping or fallback-font ownership.
- The new API would require a backward-compatibility overload; this greenfield project requires an
  atomic call-site update instead.
- Final benchmark thresholds fail after three comparable hardware runs.
- Any browser fidelity test requires an OS-specific exact bitmap snapshot.
- A new CI skip, standing loop/timer, third draw, or unbounded resource policy appears necessary.
- Documentation would need to claim the physical operator gate passed without operator evidence.

## Execution notes

Execution temporarily stopped at Step 5 on 2026-08-24 after the active CPU thresholds failed in
three runs against the recorded Plan 001 numbers. The operator then authorized a corrected baseline
measurement. Steps 1–4 are implemented in the worktree: terminal font settings, canonical fitted
geometry, the named renderer font contract, and style/spacing rasterization all pass their focused
unit and browser coverage.

The comparison exposed a defect in the Plan 001 instrument. Its browser context reported DPR 2,
but `bench/renderer-benchmark-entry.ts` did not pass `pixelRatio` to the old low-level renderer.
That renderer defaulted to DPR 1, so the recorded “DPR2” baseline rendered a 1600×800 backing
surface. The canonical fitted-font API now supplies DPR 2 explicitly and correctly renders the same
8×16 CSS grid with 16×32 device cells on a 3200×1600 backing surface. The historical active CPU
numbers therefore do not measure the geometry they claim to qualify.

Three Plan 5 hardware runs produced these per-run CPU medians against the invalid historical
comparison:

| Scenario              |  Run 1 | Run 2 | Run 3 | Three-run median | Plan 001 median | Allowed ceiling | Result |
| --------------------- | -----: | ----: | ----: | ---------------: | --------------: | --------------: | ------ |
| focused-blinking-idle |  0.30% | 0.10% | 0.20% |            0.20% |           0.10% |           0.20% | PASS   |
| unfocused-idle        |  0.00% | 0.00% | 0.00% |            0.00% |           0.00% |           0.10% | PASS   |
| burst-output          | 15.00% | 8.90% | 8.90% |            8.90% |           6.60% |           7.26% | FAIL   |
| sustained-scroll      | 14.90% | 8.90% | 8.70% |            8.90% |           6.20% |           6.82% | FAIL   |
| glyph-churn           | 11.90% | 9.30% | 9.70% |            9.70% |          23.20% |      diagnostic | PASS   |

All idle runs recorded zero submitted frames, draws, row rebuilds, instance uploads, atlas
operations, and atlas bytes. Populated frames retained exactly two draws. Glyph-churn atlas traffic
was 66,540,273, 71,423,529, and 72,113,596 bytes; the 71,423,529-byte median remains 99.633% below
the Plan 001 baseline and exceeds Plan 004's required 90% reduction.

A focused optimization made transparent undecorated cells emit degenerate cell quads, avoiding
unnecessary cell-pass fragments without changing the two-draw contract. It reduced a quick burst
sample from 9.4% to 8.9%.

The corrected baseline used a temporary detached checkout of `a7e7372` and changed only the old
renderer construction to pass `pixelRatio: 2`. Three full hardware runs produced focused-idle
medians of 0.10%, 0.30%, and 0.20%; unfocused medians of 0.00% in every run; burst medians of 8.50%,
8.50%, and 8.40%; and sustained medians of 8.50%, 8.60%, and 8.50%. The corrected median baseline
is therefore 0.20%, 0.00%, 8.50%, and 8.50% respectively.

Against that like-for-like DPR2 baseline, Plan 5's medians of 0.20%, 0.00%, 8.90%, and 8.90% pass.
Both active scenarios regress by 4.71%, below the 10% allowance; idle behavior is unchanged. The
operator authorized resuming the plan after this correction, so the original STOP condition is
resolved without relaxing a threshold. Steps 6–7 resumed. The physical Phase 3 operator gate
remains pending.

The final benchmark entry also passes the fitted device-cell dimensions to the raw Ghostty terminal.
One full run on that exact code measured 0.10% focused idle, 0.00% unfocused idle, 9.10% burst,
8.90% sustained, and 9.70% glyph churn; both active values remain below the 9.35% ceiling. The CI
launcher passed 74 unique browser tests with no new skips. `bun run verify` passed 135 unit and 74
browser tests plus typecheck, lint, format, and build. CI initially exposed an early-frame/first-fit
race; fit commit now replays the saved frame after session resize, and the focused 25-test DOM file
plus the complete launcher pass.

After the operator authorized starting the demo server, the corrected build loaded at
`http://127.0.0.1:4173/` on the hardware Apple Metal adapter without console warnings or errors.
Calendar rows, digits, punctuation, prompt glyphs, cursor, and selection remained visually aligned
at DPR 2 and after a live refit to fractional DPR 2.2. The built-in 11-second idle sample reported
`quiescent`; pending frame, timer, and link-resolution flags were all false. Its snapshot recorded
8 submitted frames and 16 draws. The headed demo is ready for the operator, while every physical
input, IME, clipboard, held-key, and VoiceOver item remains PENDING.

## Maintenance notes

- Treat the fitted-font result as a value object. Do not let consumers mutate its device geometry or
  recompute one field independently.
- Font ink bounds, cell advance, and CSS size are related but distinct. Preserve the named boundary
  in future refactors.
- xterm.js alignment here is architectural, not API compatibility. Any future drop-in layer needs a
  separate compatibility matrix and plan.
