# X3 / E4: procedural atlas sprites

Status: Approved. Decision: Keep. Native parity passed; no material warm-workload
cost regression was observed. The +1.9% unicode CPU medians remain a finding.

## Scope

The shared Canvas atlas rasterizer draws 492 single-codepoint sprites before font
text: box drawing U+2500–U+257F, blocks U+2580–U+259F, braille U+2800–U+28FF,
sextants U+1FB00–U+1FB3B, and geometric powerline U+E0B0–U+E0BF. Other glyphs,
including combining sequences and variation selectors, keep the font path.
WebGPU and WebGL2 consume the existing grayscale atlas interface. No wasm, public
API, glyph keys or renderer scheduling changed.

The geometry is adapted from the MIT-licensed Ghostty revision
`7b11f3dca034d8d24369ad3856afe57946d7902a`. The third-party notice records the
source. Canvas does not expose underline thickness. We use Ghostty's own fallback
estimate, `ceil(0.15 * 0.75 * 0.75 * ascent)`, with a minimum of one device pixel.
Here ascent is the fitted device baseline minus the character's top offset.
A font's explicit native underline metric can differ from this estimate.

## Native reference and comparison

`python3 scripts/sprites/native-reference.py <ghostty-repo> <zig> <z2d-tarball> <fixture-dir>`
compiles the pinned draw functions and sprite canvas as a native Zig test. Its
scratch adapter changes import wiring, substitutes the standard assertion, supplies
only the three consumed metric fields, and supplies test I/O instead of global
Ghostty I/O. Draw functions and canvas rasterization stay unchanged. This is a
native sprite-code reference, rather than a screenshot of the installed terminal.
It does not change the unpatched wasm build.

The checked-in fixtures contain all 492 glyphs for every combination of CSS cell
sizes 9×18, 13×27 and 18×36 with DPR 1, 1.25 and 2. Device dimensions round to
integers. A tenth sheet covers a two-cell span at 16×34 device pixels. Matching
thicknesses are recorded in the manifest. The test reconstructs each atlas bitmap
from its pixels and offsets into a padded cell, then compares with native output.

- All 4,920 glyph/metric samples passed. Rectangular glyphs match exact alpha bytes.
  Curves and diagonals use symmetric one-device-pixel coverage distance with alpha
  threshold 32/255. The search stays inside each glyph's tile.
- Full blocks cover every device pixel in all nine requested combinations, with
  no transparent edge and zero cell offset.
- Font family, bold and italic do not change sprite geometry for fixed metrics.
- Ghostty's cell-span behavior is preserved. Box, block and sextant helpers use
  base-cell metrics. Braille and filled powerline use span width. Diagonal
  powerline helpers use base-cell metrics.
- The original font path failed all nine full-block seam tests and the native
  comparison. The final atlas tests passed 19/19 in Chromium.

The generator also emits the packed box-intersection table. Regenerating the PNGs,
manifest and table produced byte-for-byte identical files. Native reference build
used Zig 0.16.0 and Ghostty's pinned z2d 0.12.1 package on Linux x86_64.

Commands used on the PC:

```sh
python3 scripts/sprites/native-reference.py \
  /work/projects/references/web-terminals/ghostty-org__ghostty \
  /work/tools/zig/0.16.0/zig \
  /work/cache/zig/p/z2d-0.12.1-j5P_Hsw8EQAKyZTQICCQnAH2xYkLDW8k9uefbsYdfPZ-.tar.gz \
  src/render/shared/atlas/sprite-fixtures
bun run test:browser src/render/shared/atlas/sprites.browser.test.ts \
  src/render/shared/atlas/canvas-rasterizer.browser.test.ts
```

The browser test saves native/candidate contact sheets under
`src/render/shared/atlas/.artifacts/sprites-case-*.png`. The 13×27, DPR 1.25 sheet
was inspected at its original 776×1572 resolution.

![Native Ghostty beside browser sprites at 13×27 and DPR 1.25](assets/X3-13x27-dpr1.25.png)

Raw receipts and contact
sheets are retained in `/work/reports/ghostty-webgpu-next-2026-10/X3/`.

## Hardware cost

Host: PC, Linux x86_64, Intel i7-14700K and NVIDIA RTX 3060 Ti. Headed
Chromium 153.0.8010.12 used ANGLE OpenGL ES 3.2 with NVIDIA 615.78.08;
WebGPU reported NVIDIA Ampere and `fallback: false`. Every window had at least
6,611 MiB free VRAM. The Mac was reserved by another lane.

Before: `d2ed8989a745f016188e0a2e749009b3e1450f33`. Runtime candidate:
`abe63a8c023d42c77bcfb0eaea09deb40dbf7662`. Later edits update tests, notices and
this receipt. The harness is the retained study L7a `bench:renderer` extension,
with a source-root override, per-window VRAM checks and a sprite-cell pixel mask.
The report directory retains its full patch and exact launch scripts.

An initial four-pair, 64-update run had mixed CPU changes from -17% to +9%.
One bounded follow-up used eight counterbalanced pairs and 256 updates, replaying
each study workload's 64 chunks four times. Both used 100×30 cells, DPR 2 and
eight warmups. Each pair matched bytes, text hashes, delivered updates, submitted
frames and empty pending-frame queues. Both packets passed the existing runner's
hardware qualification. The following medians are experimental timings.

| Workload         | Backend | Total browser CPU seconds before → after | Callback p95 ms before → after |
| ---------------- | ------- | ---------------------------------------- | ------------------------------ |
| NTCharts heatmap | WebGL2  | 0.675 → 0.670, -0.7%                     | 0.60 → 0.60                    |
| NTCharts heatmap | WebGPU  | 0.945 → 0.950, +0.5%                     | 0.70 → 0.70                    |
| unicode-varied   | WebGL2  | 0.520 → 0.530, +1.9%                     | 0.40 → 0.40                    |
| unicode-varied   | WebGPU  | 0.775 → 0.790, +1.9%                     | 0.40 → 0.45                    |

Heatmap screenshots match byte for byte. Unicode-varied changes 71,404 of
1,800,000 pixels in every pair, all inside procedural sprite cells plus their
one-device-pixel border. Ordinary, wide, combining and color text outside those
regions remains pixel-identical. Traces show zero rasterizer calls during these
warm-atlas samples. This is a cost guard for normal workload replay, rather than
a cold-rasterization speed claim. A light native-review job overlapped the last
unicode pairs, so the small timing changes do not establish a general speedup or
regression. The small positive unicode medians are retained as a finding.

[Machine-readable receipt](X3-results.json) includes renderer/GPU CPU components,
all paired pixel counts, source revisions and per-window VRAM. Raw packets and
the analysis reproducer are retained in the report directory.

## Verification and cleanup

The full browser gate passed 108 tests across six files. The compositor oracle
uses software Canvas with padding before viewport clipping. Direct GPU-backed
Canvas vector antialiasing and early clipping differed from atlas rasterization
on adjacent powerline edges. The comparison remains strict; no pixel tolerance
was relaxed. A half-block specimen replaces a full block where selection tests
must expose both foreground and background.

Build, typecheck and lint passed. The unit gate passed 1,106 Vitest tests with one
skip, 482 comparison tests and four checkpoint tests. Docs checks passed seven
tests, and formatting passed. The native fixture regeneration passed.

Scratch compilation directories are owned by Python `TemporaryDirectory` and
removed on exit. Benchmarks own their browser and page teardown. Generated bundles and duplicate PNGs have been removed; raw packets remain
losslessly compressed and image hashes map repetitions to retained examples.
The analysis passed again after compaction. The retained report is about 5.2 MiB.
The coordinator owns it until the PR is merged or rejected and the evidence is
archived. Task worktrees are removed after PR delivery; the report's cleanup
receipt records the actual host check. Checked-in fixtures remain owned by the
browser regression test and are regenerated when sprite geometry changes.
