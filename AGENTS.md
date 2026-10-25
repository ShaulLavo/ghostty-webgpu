# Repository Guidelines

## Product Direction

- The product is Ghostty for the web with its own native API; Platform is one consumer, not the scope boundary.
- Keep working notes and measurement receipts in `.internal/`.

## Organization

- `src/core/` holds browser-independent wasm loading and typed libghostty-vt bindings. It uses no DOM globals.
- `src/render/` groups backends in `webgpu/`, `webgl/`, `canvas/`, `pixels/`, and `dom/`. `shared/` owns scheduling, atlas, frame, theme, backend selection, and renderer contracts. `shaders/` owns GPU shader sources.
- `packages/line-editor/` and `packages/shaders/` are optional workspace packages.
- `bench/` holds browser benchmark entry points; `scripts/` holds their runners and the artifact builds. Generated wasm is checked in at the package root.
- Import exact files. `src/index.ts` is the only barrel because it is the package entry point.
- Read `docs/concepts.md` before changing the frame path. Read `docs/adr/` before reopening the unpatched core or the instanced WebGPU renderer.

## Array construction

For array construction: combine arrays with `concat` and use fresh array results directly. Preserve copies needed for ownership, iterable/typed-array conversion, tuple typing, or sparse-array behavior. Performance exceptions require measurements.

## Control Flow

- Keep nesting depth to three or less.
- Use guard clauses and early returns. Do not use `else` after an early return.
- In loops, invert conditions and `continue` instead of nesting the body.
- Extract inner logic into a named function when inversion is not enough.
- Never use nested ternaries.

## Comments

- Keep comments to one or two lines.
- Explain only non-obvious constraints or the bug a choice prevents.
- Do not restate the code or leave historical essays in source files.

## Package Versioning

- Greenfield: breaking changes are wanted. Rename, remove and reshape the API whenever that makes it
  better. No deprecations, aliases or shims.
- Feature PRs leave versions unchanged. Release commits bump the patch version only.

## Docs

- `README.md` ships in the npm package. Use absolute HTTPS links and image URLs in it.
- Never hand-edit `docs/benchmarks.md` or the overview table between `## Performance` and `### Correctness`. Change `docs/benchmarks/mac-m1-2026-10-10/scores.json` or `report.mjs`, run `node docs/benchmarks/mac-m1-2026-10-10/report.mjs`, then `bun run format:check`.
- Keep the paths in `docs/benchmarks/mac-m1-2026-10-*/`, `docs/correctness-results.json`, and `docs/config-resolver-feasibility.*`. Tests and CI read them.
- Put tutorial code in `site/src/examples/`. The docs checker rejects handwritten `ts` fences in `site/src/content/docs/`.
- After a docs change, run `bun run --cwd site docs:check`, `bun run format:check`.

## Build And Tests

- Autonomous performance research follows [.internal/program.md](.internal/program.md), using the current local research checkpoint and existing benchmark qualification.
- Consumers execute `dist`; run `bun run build` after source changes.
- Core tests run in plain Vitest under Node and must not require DOM globals.
- Renderer GPU tests use the separate `vitest.browser.config.ts` project and real Chromium. Do not
  move browser-only settings into the Node config.
- Performance evidence comes from `bun run bench:renderer` in headed Chromium on a hardware
  adapter. Headless SwiftShader runs prove correctness only.
- The checked-in wasm must come from `bun run build:wasm`, at the pinned official upstream
  repository and revision, without build-time patches or a maintained fork.
- The pinned source revision requires Zig 0.16.0 or newer.

- CI uses Chromium. Firefox and WebKit runs need their Playwright system dependencies installed on the execution host.
