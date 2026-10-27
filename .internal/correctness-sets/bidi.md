# C3 BiDi correctness set

Status: specification for the C3 prototype. This set defines behavior and fixtures only. It adds no test implementation.

## Contract

The terminal buffer stores logical order. Painting uses a per-row permutation between logical and visual columns. The implementation must not reverse strings or change the terminal core.

Each row has these mappings:

- `visualToLogical[v]` gives the logical column painted at visual column `v`.
- `logicalToVisual[l]` gives the visual column for logical column `l`.
- The arrays are exact inverses and cover every grid column, including wide-cell continuations.
- A paint-time mirror map replaces bracket codepoints required by UBA rule L4. Logical text and copy keep the original codepoint.

Paragraph direction is fixed LTR for each row. An all-RTL row reverses in place at the left edge. Trailing empty cells retain their order. This matches NimbleMarkets' `nm-rtl`; it does not infer paragraph direction from the first strong character.

A width-2 cell and its width-0 continuation move as one fused unit. The continuation stays immediately to the right of its base in visual order. Painting never splits or duplicates the wide glyph.

Arabic uses the same cell reordering as Hebrew. The C3 limit is explicit. Reordering adds no Arabic cursive joining across cells. Each Arabic cell keeps its existing isolated-form rasterization. A whole-row browser text oracle is therefore invalid for this set.

Selection has two coordinate spaces. Pointer anchors and highlights use visual columns. Programmatic selection ranges use logical buffer columns. Copy always returns logical text. Application mouse reports use one-based logical columns.

The BiDi tables are Unicode 13.0, matching `bidi-js` 1.0.3. This is intentionally older than Ghostty's Unicode 15.1 grapheme and width data. Updating BiDi classification requires a separate table decision; do not mix versions silently.

## References

- NimbleMarkets `lib/bidi.ts` at `95c43efb7538879dd6603539e5766de14145b414`. This defines fixed LTR rows, both permutations, wide-cell fusing, and L4 mirroring.
- NimbleMarkets selection and renderer integration at `49a0599f670c6bd4b8893a08a9105ab2f7406fe2`. This defines visual pointer selection, logical copy, logical mouse reports, and cursor mapping.
- NimbleMarkets `docs/superpowers/specs/2026-07-29-bidi-rendering-design.md` at `95c43ef`. This records the Unicode 13.0 table version and the Arabic joining limit.

Explicit BiDi controls, configurable paragraph direction, and cross-cell Arabic shaping are outside C3.

## Fixture and assertion conventions

Fixtures live in `bench/fixtures/correctness/`. Each `.vt` file is one raw UTF-8 input stream with no BOM and no final newline. Escape and BEL bytes are real bytes. Every stream resets SGR, hides the cursor unless the case exercises it, and enables DEC 2027 grapheme clustering.

Use a 40×8 grid except for the resize case. Use the existing JetBrains Mono test font with the existing emoji fallback stack. Run paint cases on WebGPU, WebGL2, Canvas, DOM, and the pixels backend at DPR 1 and 2.

The tables below show the trimmed row prefix. Any remaining grid columns map to themselves in ascending order. Visual strings use `␠` for a space. The index maps are authoritative when a markdown viewer applies its own BiDi layout.

Apply four assertion layers as needed by each case.

1. Read rows through `RenderStateSource.readRows()`. Assert logical text, wide continuations, styles, links, and cursor positions. Reordering must not mutate them.
2. Assert the exact `visualToLogical` array and its inverse. Assert mirror replacements by logical column. These are cell-position checks, not string comparisons.
3. Capture pixels with `displayedPixels()`. Build the oracle by iterating the hardcoded visual map and drawing one logical cell at each visual position with Canvas2D. Apply the expected mirror only to the painted glyph. Do not pass the whole row to `fillText()`, because the browser would apply its own BiDi and Arabic shaping. Use `expectPixelsEqual()` or the existing antialiasing tolerance of 2.
4. Drive pointer cases at visual cell centers. Assert the visual highlight, logical `getSelection()` result, link target, and exact SGR mouse bytes independently.

## Mapping cases

### Hebrew mixed with LTR text

Fixture: `bidi-hebrew-mixed.vt`.

Logical row 0 is `ab␠שלום␠cd`. Visual row 0 is `ab␠םולש␠cd`.

`visualToLogical` is `[0,1,2,6,5,4,3,7,8,9]`. `logicalToVisual` is the same array. Only the Hebrew run reverses. Assert both maps, unchanged logical text, and per-cell pixels.

### Hebrew with numbers

Fixture: `bidi-hebrew-numbers.vt`.

Logical row 0 is `אב␠12␠גד`. Visual row 0 is `דג␠12␠בא`.

`visualToLogical` is `[7,6,5,3,4,2,1,0]`. `logicalToVisual` is the same array. Hebrew reverses, while `1` remains immediately left of `2`. Assert the exact digit positions and pixels.

### Hebrew punctuation and mirroring

Fixture: `bidi-hebrew-punctuation.vt`.

Logical row 0 is `א(ב)ג`. Visual row 0 is `ג(ב)א` after mirroring.

`visualToLogical` and `logicalToVisual` are `[4,3,2,1,0]`. The mirror map contains logical 1 → `)` and logical 3 → `(`. Copy and `readRows()` retain the original `(` and `)`. Assert that the atlas or raster input uses the mirrored codepoints while copied text uses the logical codepoints.

### Arabic and Arabic-Indic digits

Fixture: `bidi-arabic.vt`.

Logical row 0 is `عربي␠٤٥٦`. Visual codepoint order is `٤٥٦␠يبرع`.

`visualToLogical` is `[5,6,7,4,3,2,1,0]`. `logicalToVisual` is `[7,6,5,4,3,0,1,2]`. The digits remain in logical left-to-right order inside the RTL run.

Assert one isolated Arabic raster input per logical cell. No raster input may contain two adjacent Arabic cells. Compare against the per-cell oracle, not a shaped Arabic string. Copy returns the original logical `عربي␠٤٥٦`.

### Wide emoji in an RTL run

Fixture: `bidi-wide-emoji.vt`.

Logical cells are `a` 0, `א` 1, `❤️` 2 with width 2, continuation 3, `ב` 4, and `z` 5. Visual text is `aב❤️אz`.

`visualToLogical` and `logicalToVisual` are `[0,4,2,3,1,5]`. The emoji occupies visual columns 2 and 3, with its base at 2 and continuation at 3. Assert that the pair stays adjacent and keeps its intrinsic colors. Exercise clicks on both emoji columns and assert the expected mapped logical column for each.

## Interaction cases

### Cursor movement

Fixture: `bidi-cursor.vt`.

The logical row and map match `bidi-hebrew-mixed.vt`. The fixture ends with CUP 1;5, so the logical cursor is column 4 and the visual cursor is column 5. The cursor glyph belongs to logical `ל`, not to whichever logical cell was originally stored at visual column 5.

Move the cursor with these sequences and assert every frame:

| CUP sequence | Logical column | Visual column |
| ------------ | -------------: | ------------: |
| `\x1b[1;4H`  |              3 |             6 |
| `\x1b[1;5H`  |              4 |             5 |
| `\x1b[1;7H`  |              6 |             3 |
| `\x1b[1;8H`  |              7 |             7 |

Assert the logical position through `readCursor()` and the painted position through cursor pixels. Block, bar, and underline cursor styles use the same mapping.

### Selection and copy in logical order

Fixture: `bidi-selection.vt`.

The logical row and map match `bidi-hebrew-mixed.vt`. Drag from visual column 1 through visual column 8. The highlighted visual cells are contiguous. Their logical columns are `{1,2,6,5,4,3,7,8}`. Copy sorts the selected logical columns and returns `b␠שלום␠c`.

Repeat with the reverse drag from visual 8 to visual 1. The highlight and copied text are identical. Then drag only visual columns 3 through 6 and assert copied text `שלום`. Assert `getSelection()`, visual selection pixels, and unchanged logical rows for each drag.

Programmatic `selectRange()` uses logical columns. Select logical 3 through 6 and assert the same copied `שלום` and visual highlight at columns 3 through 6.

### Click and drag hit-testing

Fixture: `bidi-selection.vt`.

Click the center of visual column 3. Hit-testing resolves logical column 6, `ם`. Double-click selects the logical Hebrew word at columns 3 through 6, highlights visual columns 3 through 6, and copies `שלום`.

Drag from visual column 3 to visual column 1. The visual selection covers columns 1 through 3, which map to logical `{6,2,1}`. Copy returns logical columns 1, 2, and 6 as `b␠ם`. Assert that no adjacent logical Hebrew characters leak into the copy.

### Mixed-direction word selection

Fixture: `bidi-word-selection.vt`.

Logical row 0 is `א:אa`. Double-click visual column 3, which holds logical `a`. Word finding returns the exact logical range 2 through 3. Those cells paint at visual columns 0 and 3. Copy is `אa` and never includes the colon or the unrelated logical column 0.

Assert the copied text and selected logical cells. Highlight only visual columns 0 and 3. Do not replace the logical range with a visual minimum-to-maximum range, which would also select visual columns 1 and 2. This is the regression fixed by NimbleMarkets at `49a0599`.

### Links

Fixture: `bidi-link.vt`.

The visible row and map match `bidi-hebrew-mixed.vt`. OSC 8 attaches `https://example.test` to logical columns 3 through 6. For every visual column 3 through 6, map the pointer to its logical column and assert the same URI and logical link range. Hover paints the link decoration on exactly those visual cells. Activation occurs once with the same URI.

Select the linked visual cells and assert logical copy `שלום`. The link metadata stays on logical cells after a screen update and after an unrelated write elsewhere on the row.

### Application mouse reports

Fixture: `bidi-mouse.vt`.

The row map matches `bidi-hebrew-mixed.vt`. The fixture enables button-event tracking and SGR mouse mode. Press the left button at visual column 3, row 0. Hit-testing resolves logical column 6. The exact report is `\x1b[<0;7;1M`. Release at the same cell produces `\x1b[<0;7;1m`.

Move the pressed pointer to visual column 4. The logical column is 5, so the motion report is `\x1b[<32;6;1M`. Assert raw bytes, not only decoded coordinates. Disable tracking and assert that the same pointer input emits no report.

### Resize and reflow

Fixture: `bidi-resize.vt`.

The unwrapped logical text is `ab␠שלום␠123␠cd`. Start at 10 columns. The initial logical rows are `ab␠שלום␠12` and `3␠cd`.

At 10 columns, row 0 has `visualToLogical` `[0,1,2,8,9,7,6,5,4,3]` and visual text `ab␠12␠םולש␠`. Row 1 is identity.

Resize to 14 columns. The text reflows to one logical row with `visualToLogical` `[0,1,2,8,9,10,7,6,5,4,3,11,12,13]` and visual text `ab␠123␠םולש␠cd`.

Resize to 8 columns. Logical row 0 is `ab␠שלום␠`, with `visualToLogical` `[0,1,2,6,5,4,3,7]`. Logical row 1 is `123␠cd` and is identity.

At every size, assert logical rows, both maps, and pixels. Before resizing, select the Hebrew word and place the cursor on logical `ל`. Copy remains `שלום` after both resizes, the selection follows reflow, and the cursor paints at its newly mapped visual cell.
