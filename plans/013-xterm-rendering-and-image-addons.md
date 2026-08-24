# Plan 013: Match xterm web-font, ligature, image, and WebGL addon behavior

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update the parity ledger and this plan's
> status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- scripts/bridge.zig src/core src/render src/dom src/xterm bench docs plans`
> Confirm Plans 009–012 are DONE. Re-run the renderer benchmark baseline and inspect the pinned addon
> public types/source before modifying atlas, shaping, or image ownership.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 010 and 012 DONE
- **Category**: renderer / shaping / media / addons
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

The remaining browser addons cover font readiness, cross-cell shaping, inline image protocols, GPU
renderer lifecycle, custom glyphs, atlas introspection, and device loss. They touch the most
performance-sensitive architecture and cannot be implemented as superficial API stubs.

## Target contract

Match the pinned public types and released behavior for:

- `WebFontsAddon`, standalone `loadFonts`, addon `loadFonts`, and `relayout`;
- `LigaturesAddon`, fallback ligatures, `fontFeatureSettings`, activation order, and disposal;
- `ImageAddon` options and SIXEL, iTerm IIP, and Kitty graphics protocols; reset, storage limit/usage,
  placeholders, `onImageAdded`, `getImageAtBufferCell`, and `extractTileAtBufferCell`;
- `WebglAddon`, `textureAtlas`, context-loss and atlas-page events, custom glyphs,
  `preserveDrawingBuffer`, activation/disposal, and `clearTextureAtlas`.

The compatibility `WebglAddon` may use WebGPU internally because backend technology is not the
public feature. It must nevertheless reproduce the addon's public lifecycle and observable atlas
canvas/events. The native `GhosttyWebGpuTerminal` remains WebGPU-first regardless of addon use.

## Commands you will need

| Purpose              | Command                                                                        | Expected on success                              |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Raster/shaping tests | `bun run test:browser -- src/xterm/tests/font-ligature-addons.browser.test.ts` | font loading and joined ranges match             |
| Image protocol tests | `bun run test:browser -- src/xterm/tests/image-addon.browser.test.ts`          | protocols/storage/tiles match reference          |
| WebGL adapter tests  | `bun run test:browser -- src/xterm/tests/webgl-addon.browser.test.ts`          | lifecycle/atlas/device-loss behavior matches     |
| Protocol unit tests  | `bun run test:unit -- src/xterm/tests/image-protocols.test.ts`                 | limits/chunking/malformed input pass             |
| Hardware benchmark   | `bun run bench:renderer`                                                       | qualified WebGPU thresholds and image cases pass |
| Parity/full gates    | `bun run xterm:parity && bun run verify`                                       | evidence current and repository green            |

## Scope

**In scope**:

- `src/xterm/addons/web-fonts.ts`
- `src/xterm/addons/ligatures.ts`
- `src/xterm/addons/image.ts`
- `src/xterm/addons/webgl.ts`
- only create adapters proven necessary after official-addon interop tests
- `src/render/` shaping, atlas observability, custom glyphs, image textures, device-loss recovery
- `src/core/` and `scripts/bridge.zig` native image placement/protocol seams
- DOM geometry/font invalidation needed by addons
- focused unit/browser tests under `src/xterm/tests/`
- renderer benchmark image/ligature scenarios
- official addon dev dependencies pinned to manifest versions
- fixture images/sequences with explicit licenses
- package/lock, notices, README, parity docs, and `plans/README.md`

**Out of scope**:

- Changing Ghostty cell width decisions to make ligatures fit.
- Unbounded image storage, network image fetches, or implicit clipboard/file access.
- Returning fake atlas canvases unrelated to rendered glyph data.
- Treating WebGL API calls or xterm private renderer services as public compatibility requirements.
- Packaging/publishing addon package names; Plan 014 owns artifacts.

## Git workflow

- Work in the current worktree; do not branch, commit, push, or open a PR unless requested.
- Do not hand-edit generated WASM or copy protocol fixtures without provenance.
- Record hardware/browser/font environment with every benchmark and visual qualification.

## Steps

### Step 1: Prove official-addon and native capabilities

Test each official addon unchanged against the facade. Map every private dependency and public
observable. Separately prove libghostty exposes decoded image placements, cell anchoring, scrolling,
deletion, normal/alternate buffer ownership, protocol responses, and reset semantics—not only a PNG
decode callback.

STOP if native image state cannot be exposed without a second terminal parser/store or an approved
upstream bridge. Do not begin renderer storage before placements/lifecycle are authoritative.

### Step 2: Implement web-font loading and relayout

Use the owning document's `FontFaceSet`. Match filtering by family/FontFace, adding supplied faces,
load errors, returned ordering, initial relayout option, disposal, and standalone function behavior.

Relayout through Plan 005's single font-fit boundary and invalidate atlas/grid/pointer geometry once.
Do not toggle unrelated options or install a polling timer.

### Step 3: Add render-only ligature shaping

Use the browser Font Access API when available and the exact fallback ligature set otherwise. Apply
`fontFeatureSettings`, discover ranges on logical line text, map UTF-16 ranges to Ghostty cells, and
shape/rasterize spans without changing native cursor positions, selection, or width decisions.

Cache by line revision, fitted font, feature settings, and joiner generation. Invalidate affected
rows only. Cover overlapping candidates, wide/combining/emoji boundaries, bidi-neutral terminal
order, font reload, and addon activation before/after WebglAddon.

### Step 4: Expose native image placements and bounded storage

Bridge native image commands/placements into immutable frame snapshots. Implement shared image
storage with exact pixel/byte/protocol/storage limits, FIFO eviction, placeholders, scroll/reflow/
resize/erase/alternate-screen behavior, reset, and disposal.

Render image tiles in a bounded pass strategy measured against the two-draw text contract. If images
require additional draws, qualify and document draws per visible image batch; do not silently change
the text-only two-draw invariant.

### Step 5: Match SIXEL, IIP, and Kitty protocols

Drive chunked/malformed/oversized sequences through native parser hooks. Match cursor advance,
scrolling mode, palette limits, animation/frame handling if public, transmission/query/delete
commands, size reports, responses, and rejection without partial state.

Test every option boundary at limit-1, limit, and limit+1. Protocol decoding must be bounded in time,
memory, dimensions, and decompressed pixel count.

### Step 6: Implement image public APIs

Expose original-image and tile canvases at buffer coordinates with the same coordinate system,
undefined cases, lifetime, and pixel content as reference. Keep `storageLimit`, `storageUsage`,
`showPlaceholder`, `reset`, and `onImageAdded` coherent with actual storage.

Canvas extraction copies ownership so consumer mutation cannot corrupt renderer storage unless the
reference explicitly shares it.

### Step 7: Implement the WebglAddon compatibility adapter

Map activation onto the existing WebGPU renderer lifecycle. Provide atlas canvas/page observables
from the real CPU rasterized atlas sources, emit add/remove/change events on real generations, map
WebGPU device loss to `onContextLoss`, honor custom glyph enablement, and make
`clearTextureAtlas`/terminal clearing coherent.

Determine `preserveDrawingBuffer`'s public observable and implement an equivalent snapshot guarantee
without forcing permanent GPU readback. Disposing the addon removes only addon-owned public
observability; it must not corrupt the native terminal or leak device resources.

### Step 8: Add custom glyph coverage

Match the pinned documented ranges for box drawing, block elements, Braille, Powerline, progress,
git branch, and legacy-computing symbols. Generate analytic glyphs at fitted device geometry so
lines join across letter spacing/line height. Fall back to the font when custom glyphs are disabled.

Review xterm custom-glyph source licensing/provenance before adapting definitions.

### Step 9: Benchmark, visually qualify, and update the ledger

Add ligature churn, font reload, image stream, image scroll, atlas churn, and device-loss scenarios.
Measure CPU, GPU/upload bytes, peak image memory, frame/draw counts, and idle work. Use headed hardware
for performance and cross-browser correctness for fallback paths.

Run differential public API/protocol tests and operator visual checks for glyph joining, color emoji,
SIXEL/IIP/Kitty images, eviction placeholders, and device recovery. Update only passing ledger rows.

## Test plan

- Font tests use controlled FontFace fixtures and canonical geometry.
- Ligature tests compare ranges and rendered continuity without OS-specific whole-screen snapshots.
- Protocol tests cover chunking, limits, malformed input, responses, scrolling, erase, reset, and
  alternate buffers.
- Image browser tests compare known pixels/tiles and storage counters.
- WebGL adapter tests cover real atlas events, clear, custom glyphs, device loss, and disposal.
- Benchmarks prove bounded memory/work and preserve text-only invariants.

## Done criteria

- [ ] Official-vs-adapter decisions exist for all four addons.
- [ ] WebFontsAddon loads/relayouts through the canonical font boundary.
- [ ] Ligatures shape render spans without changing native cell semantics.
- [ ] SIXEL, IIP, and Kitty graphics behavior/options/storage/public canvases match reference.
- [ ] WebglAddon public lifecycle/atlas/context/custom-glyph behavior maps to real WebGPU state.
- [ ] Image and atlas resources are bounded and disposal-safe.
- [ ] Hardware/cross-browser/visual qualifications pass with recorded evidence.
- [ ] All owned ledger rows are compatible.
- [ ] Parity and full gates pass; Plan 013 is DONE.

## STOP conditions

Stop and report if:

- Native Ghostty cannot expose authoritative image placements/protocol lifecycle.
- Ligatures would require changing native widths, cursor positions, or selection text.
- Public atlas canvases could only be fake snapshots disconnected from renderer generations.
- Protocol decoding/storage cannot enforce strict byte, pixel, dimension, and memory limits.
- Text-only rendering loses its two-draw/idle guarantees.
- Exact custom glyph adaptation lacks a completed license/provenance review.
- Hardware thresholds fail after three comparable runs.

## Maintenance notes

- Font shaping and image placement are derived rendering state; Ghostty remains VT/buffer authority.
- Keep protocol limits centralized and test every boundary.
- WebglAddon compatibility describes public behavior, not the underlying GPU API.
