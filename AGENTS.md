# Repository Guidelines

## Product Direction

- The product is Ghostty for the web with its own native API; Platform is one consumer, not the scope boundary.
- The roadmap is Fregat's [PLAN.md](https://github.com/ShaulLavo/fregat/blob/main/PLAN.md) and its `plans/`;
  this package keeps no plans of its own.

## Organization

- `src/core/` contains browser-independent wasm loading and typed libghostty-vt bindings.
- `src/render/` contains scheduler, atlas, instance, shader, and WebGPU resource ownership.
- `src/term/` and `src/dom/` are introduced only when their phase begins.
- `bench/` contains browser benchmark entry points; `scripts/` owns their runners and reproducible
  artifact builds. Generated wasm is checked in at the repository root.
- Import exact files. `src/index.ts` is the only barrel because it is the package entry point.

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
  better, and bump major, minor or patch as the change warrants. No deprecations, aliases or shims.

## Build And Tests

- Consumers execute `dist`; run `bun run build` after source changes.
- Core tests run in plain Vitest under Node and must not require DOM globals.
- Renderer GPU tests use the separate `vitest.browser.config.ts` project and real Chromium. Do not
  move browser-only settings into the Node config.
- Performance evidence comes from `bun run bench:renderer` in headed Chromium on a hardware
  adapter. Headless SwiftShader runs prove correctness only.
- The checked-in wasm must come from `bun run build:wasm`, at the pinned official upstream
  repository and revision, without build-time patches or a maintained fork.
- The pinned source revision requires Zig 0.16.0 or newer.

- Firefox/WebKit Playwright runs on the Arch dev machine need `/work/projects/platform/scripts/playwright-webkit-arch.sh` after any `playwright install` that downloads a new WebKit.
