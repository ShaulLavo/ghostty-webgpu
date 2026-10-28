# C3 bidirectional cell rendering

Status: Approved. Implementation and verification in progress.

The public `bidi` option defaults to false. A row mapper initializes `bidi-js` only for enabled
terminals. Each logical row supplies a permutation, its inverse and paint-only bracket mirrors.
The shape follows the fixed LTR paragraph and wide-pair rules in NimbleMarkets' `lib/bidi.ts`
at `95c43ef`, with its `49a0599` distinction between visual drags and logical word ranges.

The GPU bridge specializes a separate projected entry at compile time. The default entry has no
projection lookup in its cell loop. Enabled frames currently rebuild the full viewport with physical
row reuse disabled. Canvas and DOM reorder only the painted rows. Frame observers, displayed text,
copy and accessibility retain logical order. The DOM paints isolated cells to avoid browser joining.

Pointer drags store the exact selected logical cells as native tracked references. Those references
follow reflow and preserve holes in selections. Native word and line gestures keep their logical
ranges. Mouse coordinates translate before native encoding. Links resolve against logical rows
and paint one decoration per mapped visual column.

## Dependency review

- `bidi-js` 1.0.3 is MIT licensed. Its tables implement Unicode 13.0, as specified by the correctness set.
- Its declared dependency `require-from-string` 2.0.2 is also MIT licensed. The browser ESM entry does
  not import it, so it is absent from browser bundles.
- Both license notices are included in the shipped third-party notices. No reference code was copied.
- The unpatched official Ghostty core and its Unicode 15.1 width tables are unchanged.
- Reordering adds no Arabic joining across cells. Explicit controls and paragraph inference remain outside C3.

## Verification design

The Node tests assert all fixed maps, inverse maps, wide-pair fusing, mirror raster inputs, logical
state preservation, disjoint copy, word finding and selection reflow. Native record tests inspect
actual projected GPU positions independently of a browser.

The browser tests read the checked-in raw fixtures on all five backends at DPR 1 and 2. Expected
cell order is hardcoded independently of the implementation. Canvas uses a per-cell Canvas2D
oracle. GPU backends compare with ordinary native rendering of the hardcoded visual cell sequence,
which exercises the same rasterization without BiDi projection. Pixels also checks independent integer
alpha composition. DOM uses per-cell HTML at the same CSS geometry. This preserves the existing
backend rasterization differences instead of treating whole-row shaping as an oracle. The pixel
tolerance is two channel values. Cursor tests check pixels and both logical and painted positions.

Packaged worker and main-entry tests drive pointers at cell centers, assert exact logical copy and
visual highlight pixels, test noncontiguous word ranges, OSC 8 hover and activation, and exact SGR
mouse bytes including both columns of a wide emoji. Accessibility and displayed text stay logical.

## Receipts

Pending final gates. Raw receipts belong to `/work/reports/ghostty-webgpu-next-2026-10/c3/`.
Re-run bundle measurements with `bun .internal/reference-study-2026-10/bidi-bundle.mjs BASE_REF`.
