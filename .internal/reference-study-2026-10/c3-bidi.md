# C3 bidirectional cell rendering

Status: Approved. Implementation complete; awaiting review and canonical Linux CI.

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

The focused Chromium run passed 99 tests. Linux Firefox passed 76 with 23 unsupported WebGPU
cases skipped. WebKit on the M1 Mac passed all 99, including both worker backends. The normal
build, typecheck, lint, format, unit, extension and docs gates passed. The full Mac Chromium suite ran after `verify:extensions`: 69 files passed, three failed;
1,267 tests passed, ten failed and one was skipped. Both C3 files passed all 99 tests.

One failure caught an added undefined `bidi` key in default worker initialization. The key is now
omitted when disabled, preserving the original wire shape. That fix awaits canonical Linux CI.
The other nine Mac failures are **not yet compared against base**: four copy-modifier cases,
four packaged link Ctrl-click cases and the xterm held-output pixel case. The coordinator owns
that base comparison and the canonical Linux full-suite gate. The PC browser queue was cancelled
after waiting without starting. The Mac lock was released and handed to the Shell track as requested.

The final minified browser bundles add 22,504 bytes / 9,174 gzip bytes for the main entry and
20,695 bytes / 8,959 gzip bytes for the worker, against base `12d910c03` with Bun 1.4.4.

Model the Domain led to explicit permutations and tracked selected cells. Prove It Works led
to native record, per-cell pixel and raw mouse byte assertions. Architect exploration and nested
delegation were skipped because the binding lane brief forbids child agents.

Raw receipts belong to `/work/reports/ghostty-webgpu-next-2026-10/c3/`.
Re-run bundle measurements with `bun .internal/reference-study-2026-10/bidi-bundle.mjs BASE_REF`.

## Review corrections

The independent review at `b437bad1` found eager dependency loading, repeated document envelopes
in formatted copy, and lost rectangle metadata. Failing-first tests reproduced all three.

The BiDi implementation now lives behind dynamic imports. The build emits self-contained optional
BiDi modules and split worker modules. `bidi-js` is a build dependency, not a production dependency.
The initial main, core, worker-host and worker-runtime graphs contain no BiDi implementation or
tables. An independent bundle-graph probe follows all static imports, including shared chunks.

The split initial graphs still contain option-routing code. Against `58a090d56` with Bun 1.4.4,
initial main code adds 4,241 raw / 2,167 gzip bytes, worker host adds 4,269 / 1,951, and worker
runtime adds 2,952 / 2,130. The 19,682-byte BiDi implementation is deferred, about 8,754 gzip bytes.
These replace the earlier single-file bundle measurements; summing only the entry file would
incorrectly hide shared static chunks. Raw measurements are in the C3 review receipt directory.

Formatted copy stages contiguous selected logical runs in a temporary headless terminal, then
uses the native formatter once. This preserves escaping, styles, palettes and line boundaries
without parsing native HTML or concatenating document envelopes. Rectangle shape lives with the
selected-cell mask and is passed into native range installation.

The changed worker module graph exposed a Vitest dynamic-import failure in the opaque default
worker constructor. A standard static `new Worker(new URL(...), {type: 'module'})` default lets
Vite prepare that worker. Custom worker URLs keep their explicit constructor path. No test-runner
code or fallback was added to production modules.

PC checks: all 26 BiDi Node tests passed, the 24 worker/main interaction tests passed, and the raw
built-package smoke passed all 12 disabled/enabled main and worker scenarios. A focused combined
browser run initially passed 161 and failed the 16 worker cases before the constructor fix.
Full canonical Linux CI follows the pushed correction. No Mac resources were used in this review.
