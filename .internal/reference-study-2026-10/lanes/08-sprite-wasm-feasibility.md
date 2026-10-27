# L8 — procedural sprite wasm feasibility

## Result

**Outcome: does not build from the unpatched pinned source.** A separate Zig root module can import the pinned Ghostty tree and resolve z2d/zig-js, but `font/sprite/Face.zig` is not a freestanding sprite-only boundary at `7b11f3dca034…`. No wasm artifact, render benchmark, or pixel contact sheet was produced because the compile gate fails first.

The useful product conclusion is still positive for the geometry: Ghostty has a self-contained, metric-driven procedural sprite definition set, but it needs an upstream boundary change before it can feed our atlas as a native bitmap producer. Until then, port the definitions to a browser-owned Canvas/TS rasterizer or maintain a small adapter copy.

## Experiment and controls

- Pin: official Ghostty `7b11f3dca034d8d24369ad3856afe57946d7902a`, matching [`ghostty-vt.provenance.json`](/work/projects/ghostty-webgpu/ghostty-vt.provenance.json:3). The lane-owned detached worktree was `/work/reports/ghostty-webgpu-reference-study-2026-10-27/wt/L8-ghostty`; `[measured: git status --short --branch => ## HEAD (no branch); git rev-parse => 7b11f3dca034d8d24369ad3856afe57946d7902a]`.
- Compiler: `/work/tools/zig/0.16.0/zig version` returned `0.16.0`, matching the provenance compiler requirement. The default mise shim is Zig 0.17.0, so every build command explicitly used the 0.16.0 binary `[measured: command output]`.
- Root: `/work/reports/ghostty-webgpu-reference-study-2026-10-27/L8/entry.zig` imports `ghostty/src/font/sprite.zig` and asks `SpriteFace.hasCodepoint`; `/work/reports/ghostty-webgpu-reference-study-2026-10-27/L8/build.zig` supplies a separate build root, `build_options`, `terminal_options`, z2d, and dependency module names. No file in `/work/projects/ghostty-webgpu` or the reference clone was edited `[measured: git status and filesystem setup]`.
- Dependency setup: the official pinned z2d URL/hash was fetched into the lane scratch package cache; the official pinned zig-js URL/hash was also fetched. The z2d package itself is 1.2 MiB in scratch `[measured: du -sh /work/reports/ghostty-webgpu-reference-study-2026-10-27/L8/zig-pkg]`.
- Build command, via the required heavy runner: `bun /work/platform-production/heavy/current/run.js --class light "L8 sprite wasm ..." -- /work/reports/ghostty-webgpu-reference-study-2026-10-27/L8/run-lib-probe.sh`, where the script invokes `/work/tools/zig/0.16.0/zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall --summary all`. The runner executed locally and returned a nonzero build status `[measured: /work/reports/ghostty-webgpu-reference-study-2026-10-27/L8/lib-probe.log]`.

## What is reusable in the upstream code

`SpriteFace` discovers every draw definition at comptime from eight source files: block, box, braille, branch, geometric shapes, powerline, and both legacy-computing tables. It parses `draw<MIN>_<MAX>` declaration names, sorts ranges, rejects overlap, and dispatches by codepoint `[src ghostty-org/ghostty@7b11f3d src/font/sprite/Face.zig:40-145]`. `hasCodepoint` is already a clean pure lookup `[src ghostty-org/ghostty@7b11f3d src/font/sprite/Face.zig:147-170]`.

`renderGlyph` calculates cell-span width, cursor-vs-cell height, quarter-cell padding, invokes the selected draw function, trims transparent edges into the atlas, and returns width/height/bearings plus atlas coordinates `[src ghostty-org/ghostty@7b11f3d src/font/sprite/Face.zig:174-260]`. This is the right placement behavior for a native sprite-to-atlas adapter; the draw tables total 6,261 Zig source lines, including the legacy tables `[measured: wc -l /work/reports/ghostty-webgpu-reference-study-2026-10-27/wt/L8-ghostty/src/font/sprite/{Face.zig,canvas.zig} ...]`.

The canvas is alpha8 and its ordinary pixel/rect operations are portable. Only the z2d context path needs I/O: `Canvas.getContext` calls `z2d.Context.init(global.io(), ...)` `[src ghostty-org/ghostty@7b11f3d src/font/sprite/canvas.zig:257-263]`. The sprite canvas also imports `font/main.zig` for `font.Metrics`, `font.sprite.Canvas`, and `font.Atlas` types `[src ghostty-org/ghostty@7b11f3d src/font/sprite/canvas.zig:1-8]`.

## Exact build failures

The build was run twice with the same unpatched source and real zig-js package, changing only the shimmed `terminal_options.artifact` value to show the library boundary explicitly.

With `terminal_options.artifact = .lib`, the first relevant upstream diagnostic is:

```text
ghostty/src/global.zig:23:17: error: global state cannot be used in libghostty-vt
        .lib => @compileError("global state cannot be used in libghostty-vt"),
```

That is an intentional guard in the pinned file `[src ghostty-org/ghostty@7b11f3d src/global.zig:18-24]`, reached because the sprite canvas imports `global.zig` and calls its global I/O accessor `[src ghostty-org/ghostty@7b11f3d src/font/sprite/canvas.zig:257-263]`. The same run also reported eight other errors from pulling the full font package into wasm:

```text
/work/tools/zig/0.16.0/lib/std/Io/Threaded.zig:2064:45: error: ... posix.system ... has no member named 'getrandom'
/work/tools/zig/0.16.0/lib/std/posix.zig:90:27: error: ... has no member named 'IOV_MAX'
ghostty/src/font/Atlas.zig:443:21: error: root source file struct 'ghostty.src.os.wasm' has no member named 'toHostOwned'
ghostty/src/font/DeferredFace.zig:462:28: error: no field named 'points' in struct 'ghostty.src.font.face.Options'
ghostty/src/font/face/web_canvas.zig:274:36: error: missing struct fields ...
ghostty/src/font/face/web_canvas.zig:553:70: error: missing struct field: grid_metrics
ghostty/src/font/shaper/web_canvas.zig:244:49: error: no field named 'cell_buf'
ghostty/src/font/shaper/web_canvas.zig:264:21: error: root source file struct 'ghostty.src.font.main' has no member named 'GroupCache'
```

The complete receipt is retained in scratch at `/work/reports/ghostty-webgpu-reference-study-2026-10-27/L8/lib-probe.log` until cleanup `[measured: heavy-runner output]`.

With `.ghostty`, the explicit global guard disappears, but the remaining eight errors above persist (the two `std.Io`/POSIX errors, the wasm helper, and the stale font face/shaper errors) `[measured: /work/reports/ghostty-webgpu-reference-study-2026-10-27/L8/ghostty-probe.log]`. This means a root-module declaration or build option can select the artifact branch, but cannot make the sprite dependency graph freestanding.

The reason the graph reaches those unrelated APIs is visible in unpatched `font/main.zig`: every wasm compile explicitly analyzes `Atlas.Wasm`, `DeferredFace.Wasm`, `face.web_canvas.Wasm`, and `shape.web_canvas.Wasm` `[src ghostty-org/ghostty@7b11f3d src/font/main.zig:33-40]`. `Atlas.Wasm` references the absent `os.wasm.toHostOwned` helper `[src ghostty-org/ghostty@7b11f3d src/font/Atlas.zig:409-443]`; `os/wasm.zig` defines only `shared_mem` and `alloc` at this revision `[src ghostty-org/ghostty@7b11f3d src/os/wasm.zig:1-25]`. The selected browser face and shaper also contain field/API mismatches at this pin `[measured: compiler diagnostics above]`.

`global.io()` is not a cheap type-only import. The pinned global module owns process state, initializes `std.Io.Threaded`, and its public `io()` returns the state I/O object `[src ghostty-org/ghostty@7b11f3d src/global.zig:54-124; src/global.zig:253-260]`. That explains both the `.lib` compile guard and the wasm `Threaded`/POSIX diagnostics `[measured: compiler diagnostics above]`.

## Smallest upstreamable change

1. **Make the sprite canvas I/O explicit and lazy.** Move the `global` import inside the native convenience constructor, add a `Canvas.initWithIo`/stored `std.Io` (or an explicit `getContext(io)`), and add a `SpriteFace.renderGlyphWithIo` entry point. The wasm wrapper can then use a tiny caller-owned I/O object and never analyze `global.zig`. This change is localized to `canvas.zig`, the few `getContext` callers, and the face render entry; the four current draw-call `getContext` sites are `[measured: rg -n 'getContext\\(' src/font/sprite src/font/sprite/draw]`. The current dependency is specifically one call to `global.io()` `[src ghostty-org/ghostty@7b11f3d src/font/sprite/canvas.zig:257-263]`.
2. **Stop `font/main.zig` from eagerly analyzing unrelated wasm APIs for a sprite-only consumer.** An upstreamable root marker/feature option around lines 33-40 (or, preferably, a small `font/sprite` module that imports only `Metrics`, `Atlas`, Canvas and draw tables) would avoid `Atlas.Wasm`, browser-face, deferred-face and shaper analysis. A prior external patch demonstrates the exact shape of the guard: `if (builtin.target.cpu.arch.isWasm() and !@hasDecl(@import("root"), "ghostty_lib_vt_sprite_only"))` `[src anomalyco/ghostty-web@6e24d04 patches/ghostty-wasm-api.patch:17-30]`. That patch also adds the sprite-only root marker and an export wrapper `[src anomalyco/ghostty-web@6e24d04 patches/ghostty-wasm-api.patch:50-59; 144-229]`, but it does **not** solve our pinned `global.io()` guard because its base revision predates this explicit `.lib` rejection `[src ghostty-org/ghostty@7b11f3d src/global.zig:18-24; src anomalyco/ghostty-web@6e24d04 patches/ghostty-wasm-api.patch:30-49]`.
3. **Keep the public output ABI outside Ghostty.** The external wrapper can own a grayscale output buffer and copy the cropped atlas region plus bearings; anomalyco’s wrapper uses this shape (codepoint, cell dimensions, thickness, output pointer/length, width/height/offsets) `[src anomalyco/ghostty-web@6e24d04 patches/ghostty-wasm-api.patch:149-229]`. This is a sensible separate API, not a reason to expose the whole native font resolver.

These are upstream proposals, not changes made in this study. They preserve the unpatched parser and do not require a fork in the product. The most maintainable version is a first-class `font/sprite` freestanding module with explicit I/O, rather than a root marker that makes an otherwise broad `font/main` graph conditionally analyzable `[hypothesis: API design recommendation]`.

## Unpatched alternatives

- **Browser-owned procedural rasterizer:** port the finite draw definitions and metric rules to TypeScript/Canvas. xterm.js already has a browser custom-glyph entry with a codepoint-definition table and a single `tryDrawCustomGlyph` dispatch `[src xtermjs/xterm.js@991857a CustomGlyphRasterizer.ts:34-64; CustomGlyphDefinitions.ts:65-126]`. Its block vectors and braille paths are straightforward Canvas operations `[src xtermjs/xterm.js@991857a CustomGlyphRasterizer.ts:129-147; 167-194]`. This keeps browser font/Canvas ownership and avoids an extra wasm boundary, at the cost of maintaining parity with Ghostty’s evolving draw tables `[hypothesis]`.
- **Port only the high-value classes:** box drawing, blocks, braille and powerline cover the common terminal seams; leave legacy computing and branch symbols on Canvas text until demand warrants a port `[hypothesis]`. Use the pinned Ghostty draw tables as source evidence, then add per-class pixel receipts when implemented `[src ghostty-org/ghostty@7b11f3d src/font/sprite/Face.zig:60-70]`.
- **Temporary source adapter:** copy the relevant draw/canvas files into a small owned package and replace the global I/O call with an explicit `std.Io`. This is technically possible, but it becomes a forked copy whose update cost should be measured against a TypeScript port `[hypothesis]`.

## What was not measured

No wasm size, render-time microbenchmark, or browser Canvas contact sheet was generated because the first compilation gate failed. There is no honest bitmap or seam comparison to report. The failed root/build scripts and fetched package cache were scratch-only and are removed during cleanup; this note retains the exact command, diagnostics, source lines, and alternative path `[measured: cleanup plan]`.
