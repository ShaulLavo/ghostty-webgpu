# C2 ligature correctness set

Status: specification for the C2 prototype. This set defines behavior and fixtures only. It adds no test implementation.

## Contract

The terminal buffer keeps logical text and cell ownership unchanged. A joined run is a paint-time unit with a half-open logical cell range `[start, end)`. The renderer draws the run's original string with the primary font into one multi-cell glyph. It never substitutes a Unicode ligature codepoint into the buffer, selection, or clipboard.

The run finder uses OpenType substitutions in the primary font. A run breaks at these boundaries:

- A cursor on any cell in the candidate range. A cursor before or after the range does not break it.
- A selection boundary inside the candidate range. A fully selected or fully unselected range may stay joined.
- A change of font, foreground, bold, italic, underline, or another glyph-affecting style.
- A fallback-font, wide, or color glyph that the primary font run cannot paint.
- The Latin pairs `fi`, `fl`, and `st`. Native Ghostty and Rio exclude these pairs because one narrow glyph damages the terminal cell grid.

A background-only change has no glyph-ink constraint. The test requires independent cell backgrounds and accepts a joined run or separate runs. Every other case has an exact run expectation.

With the option disabled, the renderer uses its existing per-cell path and produces the same pixels as current main. These cases do not define performance goals.

## References

The policy comes from these sources.

- xterm.js `src/browser/services/CharacterJoinerService.ts` at `991857a1b1cacf06f9531ba74a6e927a7a6398bb`. String ranges become cell ranges, zero-width cells do not advance string offsets, and attribute changes bound candidates.
- xterm.js `src/browser/renderer/dom/DomRendererRowFactory.ts` at the same revision. A cursor inside a range or mixed selection state disables the join.
- Native Ghostty `src/font/shaper/run.zig` at `68640f3049d5ae76d7d5eebb5bbdf713a3a98713`. Cursor, selection, font, and style changes break runs. Background color does not affect shaping. `fi`, `fl`, and `st` stay separate.
- Rio `rio-grid/src/lib.rs:2192` through `2251` at `ec9ca5043e140c864cb9448eb27574c893132c33`. Its selection, Latin-pair, cursor, style, and font checks match the same grid policy.

## Fixture and assertion conventions

Fixtures live in `bench/fixtures/correctness/`. Each `.vt` file is one raw UTF-8 input stream with no BOM and no final newline. Escape bytes are real bytes, not printable `\x1b` text. Every stream resets SGR, hides the cursor unless the case exercises it, and enables DEC 2027 grapheme clustering.

Use the existing JetBrains Mono test font from `src/tests/fonts.ts` as the primary font. Use `NotoSansMono-Regular.ttf` for the no-ligature case. Its GSUB features contain no `liga`, `calt`, or `dlig` feature. `NotoSansMono-LICENSE.txt` is its license.

Run each browser case on WebGPU, WebGL2, Canvas, DOM, and the pixels backend. Use DPR 1 and 2. Run the overhang case at 16×24 and 13×27 device-pixel cells. Use a 40×8 grid except where a case says otherwise.

Apply three assertion layers.

1. Read logical rows through `RenderStateSource.readRows()`. Compare text, continuation cells, cursor column, and style with the case expectation. Ligature rendering must not mutate these values.
2. Inspect the run finder's ranges or the rasterizer inputs. Ranges use zero-based, half-open logical columns. A wide continuation cell occupies an index but contributes no text or glyph.
3. Capture displayed pixels with `displayedPixels()`. Build an independent Canvas2D oracle with explicit `fillText()` calls for the expected runs, following `expectGlyphInk()` in `src/render/tests/zig-unicode.browser.test.ts`. Do not obtain the oracle from the run finder. Compare with `expectPixelsEqual()` when the backends are exact, or the existing channel tolerance of 2 for antialiasing. Include pixels outside individual cell rectangles so clipping cannot pass.

Text-only selection cases use `getSelection()`. Browser selection cases also compare the highlighted pixels with a per-cell oracle.

## Cases

### Programming ligatures

Fixture: `ligature-programming.vt`.

Logical row 0 is `=>␠!=␠->␠===␠<=>`, where `␠` denotes one space. The expected joined ranges are `[0,2)`, `[3,5)`, `[6,8)`, `[9,12)`, and `[13,16)`. Each range paints as one joined run across its original cells. Logical text and copy remain the five original ASCII tokens.

Assert the exact ranges. Assert one multi-cell raster input per range and no per-cell glyph inside those ranges. Compare pixels with the explicit five-run Canvas2D oracle.

### Cursor inside and at the edges

Fixture: `ligature-cursor.vt`.

Logical row 0 is `a=>b`. The fixture leaves the visible cursor at logical column 1, the left edge of `=>`. The expected result has no joined range. The cursor paints in column 1, with separate `=` and `>` glyphs.

Move the cursor with CUP and repeat the frame assertion:

| CUP sequence | Logical cursor | Expected run |
| ------------ | -------------: | ------------ |
| `\x1b[1;2H`  |              1 | none         |
| `\x1b[1;3H`  |              2 | none         |
| `\x1b[1;1H`  |              0 | `[1,3)`      |
| `\x1b[1;4H`  |              3 | `[1,3)`      |

Columns 1 and 2 are the two edges of the two-cell ligature. Columns 0 and 3 are outside it. At every position, assert the logical cursor through `readCursor()`, the run topology, and cursor and text pixels.

### Selection splitting a ligature

Fixture: `ligature-selection.vt`.

Logical row 0 is `a=>b`. Select only logical column 1, only column 2, and then the range 1 through 2. The first two selections split the run and highlight only their cell. The full `=>` selection may use one joined run because all its cells have the same selection state.

Assert copied text as `=`, `>`, and `=>` respectively. Assert no joined range for either partial selection. Compare selection backgrounds and glyph pixels with the per-cell oracle. Clear the selection and assert that the pixels return to the unselected `[1,3)` frame.

### Overhanging glyphs

Fixture: `ligature-overhang.vt`.

Logical row 0 is `a<=>b`. The expected joined range is `[1,4)`. The joined glyph occupies three logical cells, with its raster padding and bearings preserved. Ink may cross a cell boundary. It must not be clipped to the first cell, the last cell, or an unpadded atlas rectangle.

Compare the full row against one Canvas2D `fillText('<=>')` run flanked by `a` and `b`. Include a one-cell margin around the run in the pixel comparison. Repeat at both cell sizes and DPR values.

### Fallback-font fragments

Fixture: `ligature-fallback.vt`.

Logical row 0 is `a=>🙂!=b`. Cell columns are `a` 0, `=` 1, `>` 2, `🙂` 3, its continuation 4, `!` 5, `=` 6, and `b` 7. The expected joined ranges are `[1,3)` and `[5,7)`. The emoji uses fallback and forms its own run. No run contains text from both sides of the fallback glyph.

Assert the ranges and font identity of every raster input. Assert that the continuation cell contributes no string offset. Compare text and fallback pixels with the explicit three-part oracle.

### Wide cells

Fixture: `ligature-wide.vt`.

Logical row 0 is `a界=>b`. Columns are `a` 0, `界` 1, continuation 2, `=` 3, `>` 4, and `b` 5. The expected joined range is `[3,5)`. Row 1 is `a=界>b` and has no joined range.

Assert both ranges and continuation positions. On row 0, the joined string is exactly `=>`, not a string shifted by the wide cell's UTF-16 length. Compare both rows with the Canvas2D oracle.

### Color glyphs

Fixture: `ligature-color.vt`.

Logical row 0 is `=>🙂!=`. The expected joined ranges are `[0,2)` and `[4,6)`. Columns 2 and 3 are the color emoji and its continuation. The emoji keeps its intrinsic colors. Selection or cursor recoloring must not tint it as grayscale text.

Assert that the two ligature runs use grayscale atlas entries and the emoji uses a color entry. Compare color pixels before and after a full-row selection. The emoji's intrinsic color pixels stay unchanged while its cell background and selection state change.

### Style changes mid-run

Fixture: `ligature-style.vt`.

Every logical row is `a=>b`. The rows have these styles and expectations:

| Row | Style change          | Expected result                                              |
| --: | --------------------- | ------------------------------------------------------------ |
|   0 | Red foreground on `>` | No joined range. Only `>` is red.                            |
|   1 | Bold on `>`           | No joined range. Only `>` is bold.                           |
|   2 | Underline on `>`      | No joined range. Only `>` is underlined.                     |
|   3 | Red background on `>` | Joined or separate runs. Only column 2 has a red background. |

Assert every cell's logical style. For rows 0 through 2, assert separate raster inputs and compare pixels with per-cell text. For row 3, compare the complete pixels and require an uninterrupted text run's ink with independent backgrounds.

### A font without ligatures

Fixture: `ligature-no-ligature-font.vt` plus `NotoSansMono-Regular.ttf`.

The logical row matches `ligature-programming.vt`. Load the fixture font with `FontFace` and use it as the only family. The expected joined-range list is empty. Every ASCII character paints in its own cell with default OpenType features.

Assert that the primary-font run finder returns no ranges for the fixture. Compare pixels with per-cell Canvas2D text. This case detects a renderer that joins characters without evidence from the font.

### Latin grid policy

Fixture: `ligature-latin-policy.vt`.

Logical row 0 is `office␠float␠st␠=>`. The pairs at logical columns `[2,4)`, `[7,9)`, and `[13,15)` are `fi`, `fl`, and `st`. They remain separate even if a font offers a discretionary substitution. The final programming ligature at `[16,18)` stays joined.

Assert the exact range list contains only `[16,18)`. Compare the Latin text with per-cell Canvas2D text and the final token with one joined run.
