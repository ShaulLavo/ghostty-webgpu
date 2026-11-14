# WebKit Canvas and emoji follow-up

This work starts at PR 134 snapshot `3e46eecf627ad5d42dbfd4ac558c033f66a248af`.
The qualified baseline installs the frozen lockfile and builds the root package, shaders,
and line editor before running browser tests. Every run uses the PC heavy runner.
There are no native Mac or iPhone results in this report.

## Three fixture assumptions

The six Canvas failures and the Canvas mixed COLR failure come from fixture assumptions.
No product source change is justified by these controls.

1. A missing first font family does not select the already-loaded second family in Linux
   WebKit's initial Canvas font resolution. A standalone `24px MissingProbe, FallbackProbe`
   measures `M` at 19.9921875 instead of the direct fallback's 14.39996337890625. Both HTML
   and OffscreenCanvas reproduce it. Registering a loaded first-family face restricted to
   `M` keeps the metric stable while `W` still comes from the second family. The late-font
   fixture now does that before loading the late `W`-only face. It keeps the original
   stable `M` and `Mg` assertions, increased `W` ink assertion, and fresh-renderer pixel oracle.
2. Linux WebKit gives identical translucent glyph coverage different unpremultiplied RGB
   values on a 320 × 20 row surface and a 320 × 120 viewport surface. A standalone draw
   produces 201 different RGB bytes with no alpha differences, on both HTML and
   OffscreenCanvas. Chromium and Firefox produce zero differences. Attachment and readback
   hints do not remove the difference. A simple same-sized pixel round trip is exact.
   The scroll fixture's test-only ReferenceRenderer uses a row-sized scratch canvas, so its
   independent full repaint must use row-sized rasterization and upload too. The new oracle
   repaints every row from current native state and never reuses retained rows or calls
   ReferenceTarget. All byte equality, damage, readback, upload, and failure assertions stay.
3. The inline reference canvas starts on a fractional CSS coordinate in WebKit. Its
   624 × 144 box at y = 197.5 captures as 624 × 145. Both emoji canvases now use block layout,
   giving integer positions and equal screenshot dimensions. Pixel thresholds stay unchanged.
   The Canvas mixed COLR case then passes all theme, SGR, selection, and contrast phases.

## Validation

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd packages/shaders build
bun run --cwd packages/line-editor build
GHOSTTY_BROWSER_ENGINE=webkit bun run test:browser \
  src/render/canvas/scroll.browser.test.ts \
  src/render/canvas/renderer.browser.test.ts src/render/tests/emoji.browser.test.ts
```

Before the fixes, the focused command reports `9 failed | 63 passed | 3 skipped`.
After the fixes, the two Canvas files report `56 passed | 1 skipped`.

The broader command uses `src/render/canvas/ src/render/tests/emoji.browser.test.ts
src/render/pixels/` as filters. Chromium passes 116 cases. Firefox passes 113 and skips the
three existing WebGPU cases. WebKit passes 111, skips the same three cases, and fails only
the two WebGL emoji cases described below. Build, typecheck, lint, and format checks pass.

A deliberate test-only row-copy mutation changes its source band to its destination band.
The retained-scroll case fails with `expected 2854 to be +0`, then passes after restoration.
The original injected readback failure and complete-refill checks also pass. Exact comparison
still detects corrupt row transport.

The remaining WebGL cases are `presents legacy and clustered ZWJ emoji through webgl2`
and `recolors cached mixed COLR layers through webgl2`. After capture dimensions are fixed,
the first reports 14753 differing pixels. Mixed COLR reports 460 on its first phase and 230
on subsequent phases. The coordinator's WebGL presentation worker owns the underlying
presentation investigation. These assertions remain active and failing in this snapshot.

## Evidence and scope

`/work/reports/goals/ghostty-shell-20261114/canvas-followup` contains the baseline, controls,
mutation, and browser logs. `controls.ts` runs all three engines without importing terminal
code or starting a Vite server. Run it through the heavy runner with the checkout path and
an output JSON path. `controls.json` contains its measurements.

The updated PR 134 parent at `71f249fa62c31b831508d3f64ca64576c556a9ae` is merged into
this branch. After its registration owner closed the claim, the coordinator granted this
worker the three Canvas scroll metadata files. Only the `canvas-scroll` source hash,
source-key lines, newline count, and screenshot-call lines change. All 15 expanded case
objects deep-equal the parent after omitting only `sourceKey`. Their 12 declaration sites,
names, order, ordinals, 15000 ms clocks, zero retries, captures, and fixed exclusions stay.
The exact allowlist and preservation result are in `refresh-canvas.ts` and
`preservation.json` beside the browser evidence.

The required Node Vitest checks cover `ios-browser-source`, `ios-browser-canvas-scroll`,
and `ios-browser-capability-imports`. They run through the PC heavy runner without opening
a native session. There is no native Safari credit. No SDK pins, versions, font atlas source,
or WebGL source change. The existing scroll test imports the new primitive repaint helper.

Fix Root Causes separated browser behavior from renderer faults. Build the Lever produced
the standalone three-engine controls and mutation check. Prove It Works required the real
browser matrix and the corrupt-copy negative control. Laziness Protocol kept the diff in
fixtures instead of adding browser-specific product branches.
