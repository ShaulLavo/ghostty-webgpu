# Font geometry and Canvas comparison

The native terminal sizes rows from the loaded font's bounding box. Its `font.lineHeight`
multiplies that measured height. A font size of 12 CSS pixels describes the font's em size;
it does not require a 12-pixel font box or row.

## Native fitted units

[`fitTerminalFont`](../src/dom/fit.ts) measures `M` for advance width and `Mg` for vertical
metrics at `font.size` CSS pixels and `font.weight`. Canvas `fontBoundingBoxAscent` and
`fontBoundingBoxDescent` describe the font box in CSS pixels. `actualBoundingBoxAscent` and
`actualBoundingBoxDescent` describe the ink bounds of the measured text. The fitter prefers
the font box so row height remains independent of the ink in `Mg`.

Each ascent and descent uses the first nonzero value among its font-box metric, its ink
metric, and the fallback `font.size * 0.8` or `font.size * 0.2`, respectively. If Canvas2D
measurement is unavailable, a hidden span with `line-height: normal` supplies width,
ascent, and descent.

[`TerminalFittedFont`](../src/term/types.ts) keeps device pixels distinct from CSS pixels.
For DPR `d`, measured ascent `a`, descent `b`, advance `w`, and line-height multiplier `l`:

```text
deviceCharHeight = ceil((a + b) * d)
deviceCellHeight = floor(deviceCharHeight * l)
cssCellHeight = deviceCellHeight / d
charTop = l == 1 ? 0 : round((deviceCellHeight - deviceCharHeight) / 2)
deviceBaseline = charTop + ceil(a * d)
deviceCharWidth = floor(w * d)
deviceCellWidth = deviceCharWidth + round(letterSpacing * d)
cssCellWidth = deviceCellWidth / d
```

`font.lineHeight` is finite and at least 1. It is a multiplier of the measured font box,
with device rounding before and after multiplication. It is neither a CSS row height in
pixels nor the CSS unitless multiplier of `font.size`.

The DOM host commits the fitted font and the session's CSS cell metrics together.
With `autoFit: false`, that commit preserves the requested column and row counts.
With automatic fitting, the host divides available CSS width and height by the fitted
CSS cell dimensions. [`CanvasSurface.resize`](../src/render/canvas/renderer.ts) then sets:

```text
canvas.width = columns * deviceCellWidth
canvas.height = rows * deviceCellHeight
canvas.style.width = columns * cssCellWidth
canvas.style.height = rows * cssCellHeight
```

Canvas paints in device pixels with a DPR-scaled font and an identity transform.
Native row readers report terminal cells and cell spans. Their column and row counts
remain independent of backing pixels.

## Pinned ghostty-web 0.4.0 units

The installed package's `ITerminalOptions` and `RendererOptions` expose `fontSize` and
`fontFamily`. Neither exposes `lineHeight`. The comparison entry therefore passes no
line-height option to this counterpart.

Its `CanvasRenderer.measureFont` measures the ink of `M` at the configured CSS font size.
It computes these CSS metrics before multiplying the canvas backing dimensions by DPR:

```text
ascent = M.actualBoundingBoxAscent || fontSize * 0.8
descent = M.actualBoundingBoxDescent || fontSize * 0.2
height = ceil(ascent + descent) + 2
baseline = ceil(ascent) + 1
width = ceil(M.width)
```

The two extra pixels are fixed CSS padding. A zero descent on `M` takes the `0.2 * fontSize`
fallback. Its renderer paints with the configured CSS font size and a DPR scale transform.
These rules differ from the native font-box multiplier and device-pixel rounding.

The package declarations and implementation are in `node_modules/ghostty-web/dist/index.d.ts`
and `node_modules/ghostty-web/dist/ghostty-web.js` after `bun install --frozen-lockfile`.
This contract describes the pinned version, not future releases.

## Bench Mono at 12 CSS pixels and DPR 2

A static Chromium 153.0.8010.12 capture reproduced these values in both the frozen
`a2c18b56254479b9353cc20a95017cedd81b2d9d` bundle and current-main
`53e08cafc` source. Both regular and bold `FontFace` entries were loaded before mounting.
Bench Mono is the local JetBrains Mono Latin fixture. The regular WOFF2 SHA256 is
`14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb`.

The measured regular font has these CSS metrics:

- `M` advance is 7 pixels. Its ink ascent is 9 and descent is 0.
- `Mg` ink ascent is 9 and descent is 3.
- `Égj` ink ascent is 12 and descent is 3.
- Each sample's font-box ascent is 12 and descent is 4.
- An independent `Mg` span with `line-height: normal` is 16 pixels high.
- The system `monospace` control has a 7.2000579833984375-pixel `M` advance and a
  16-pixel font box. That distinct advance confirms the loaded fixture measurement.

The native derivation is `ceil((12 + 4) * 2) = 32` character pixels, then
`floor(32 * 1.2) = 38` cell pixels. Twelve rows occupy 456 backing pixels and 228 CSS
pixels. The native baseline is `3 + 24 = 27` device pixels.

The counterpart derivation is `ceil(9 + 12 * 0.2) + 2 = 14` CSS cell pixels.
Twelve rows occupy `14 * 12 * 2 = 336` backing pixels and 168 CSS pixels.
Its baseline is `ceil(9) + 1 = 10` CSS pixels. Both backings are 560 pixels wide.

The native 560 × 456 backing is correct for its fitted-font contract. The discrepancy
comes from font-box versus ink measurement, the counterpart's zero-descent fallback,
and different line-height policies. Removing the native multiplier would still produce
a 384-pixel backing height, so the missing counterpart option alone does not explain
all 120 pixels of the difference.

## Comparison limits and guards

The benchmark shares font family, em size, DPR, and terminal cell counts. The configured
`lineHeight: 1.2` applies to native and xterm; ghostty-web 0.4.0 has its own fixed policy.
Those settings describe a same-input, same-cell-count comparison with different row
geometry. They do not establish equal pixel area or justify an area-normalized CPU claim.
The static capture adds no timed workload.

These numeric font metrics describe this browser and fixture. Other fonts, browser text
metrics, and fallback glyphs can differ. A loaded face proves readiness for measurement;
it does not identify the font that a browser chooses for every Unicode glyph.

[`font-geometry.browser.test.ts`](../src/dom/tests/font-geometry.browser.test.ts) loads the
local fixture and checks the native formula at DPR 1, 1.25, and 2 and line-height 1 and 1.2.
It also opens a real native Canvas terminal, verifies its committed grid and backing,
checks painted row boundaries, and checks the pinned counterpart's public renderer metrics.
The tests derive expectations from browser measurements so they remain portable.

Relevant browser definitions are MDN's
[`fontBoundingBoxAscent`](https://developer.mozilla.org/en-US/docs/Web/API/TextMetrics/fontBoundingBoxAscent)
and [`actualBoundingBoxAscent`](https://developer.mozilla.org/en-US/docs/Web/API/TextMetrics/actualBoundingBoxAscent).
