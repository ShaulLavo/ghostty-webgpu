# Repository Guidelines

## Organization

- `src/core/` contains browser-independent wasm loading and typed libghostty-vt bindings.
- `src/term/`, `src/render/`, and `src/dom/` are introduced only when their phase begins.
- `scripts/` owns reproducible artifact builds. Generated wasm is checked in at the repository root.
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

## Build And Tests

- Consumers execute `dist`; run `bun run build` after source changes.
- Core tests run in plain Vitest under Node and must not require DOM globals.
- The checked-in wasm must come from `bun run build:wasm`, at the pinned upstream revision, without patches.
- The pinned upstream revision requires Zig 0.16.0 or newer.
