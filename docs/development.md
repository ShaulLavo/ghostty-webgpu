# Development

How to build, test, and change ghostty-webgpu. Development happens in the [Fregat](https://github.com/ShaulLavo/fregat) monorepo under `ghostty-webgpu/`. The standalone ghostty-webgpu repository is a read-only mirror, so send changes to Fregat. Read the [contribution guide](https://github.com/ShaulLavo/fregat/blob/main/CONTRIBUTING.md) first, and [AGENTS.md](../AGENTS.md) for the code conventions.

## Set up

You need [Bun](https://bun.sh/) (the repo pins 1.4.4 in `packageManager`) and Node 20 or newer.

```sh
git clone https://github.com/ShaulLavo/fregat.git
cd fregat
bun install --frozen-lockfile
bun run --cwd hotkeys/packages/hotkeys build
bun run --cwd ghostty-webgpu build
```

The first build is `@fregat/hotkeys`, which ghostty-webgpu imports from its own `dist/`. The second `build` compiles TypeScript to `dist/` and bundles the worker. Consumers import `dist`, so rebuild after every source change.

To see your build in a browser, run `bun run --cwd ghostty-webgpu demo`. It serves a terminal lab with a real shell at `http://127.0.0.1:4173`.

## Run the checks

Run these from `ghostty-webgpu/`.

| Command                | What it proves                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `bun run typecheck`    | TypeScript compiles.                                                               |
| `bun run lint`         | `oxlint` passes.                                                                   |
| `bun run format:check` | `oxfmt` formatting, including the markdown in this folder.                         |
| `bun run test:unit`    | Node tests: the core, the benchmark scripts, the research checkpoint.              |
| `bun run test:browser` | Renderer and DOM tests in real Chromium. Needs Playwright's Chromium.              |
| `bun run verify`       | Build, typecheck, lint, format, all tests, the renderer smoke, the packed install. |

Pass a path to run one browser file: `bun run test:browser src/render/tests/selector.browser.test.ts`. Headless software-GPU runs prove correctness only. Performance numbers need headed Chromium on a hardware adapter (`bun run bench:renderer`).

Set `GHOSTTY_BROWSER_ENGINE` to `firefox` or `webkit` to run the browser suite there. CI does not.

## Rebuild the wasm

`ghostty-vt.wasm` and `bridge.wasm` are checked in. Rebuild them with `bun run build:wasm`. It needs Zig 0.16.0 or newer, and it builds the pinned upstream Ghostty revision from `ghostty-vt.provenance.json` without patches ([ADR 001](adr/001-unpatched-pinned-ghostty-core.md)). Rebuild `canvas-compose.wasm` with `bun run build:canvas-compose`.

## Where things live

| Path                     | Holds                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/`              | Wasm loading and typed `libghostty-vt` bindings. No DOM globals.                                                                                                                     |
| `src/term/`              | `TerminalSession`: selection, links, events.                                                                                                                                         |
| `src/dom/`               | The `Terminal` host: fitting, input, accessibility, clipboard.                                                                                                                       |
| `src/render/`            | `webgpu/`, `webgl/`, `canvas/`, `pixels/`, `dom/` backends. `shared/` holds the scheduler, glyph atlas, frame contracts, and backend selection. `shaders/` holds GPU shader sources. |
| `src/worker/`            | The `ghostty-webgpu/worker` entry.                                                                                                                                                   |
| `src/config-resolver/`   | The host-only `ghostty-webgpu/config-resolver` entry.                                                                                                                                |
| `scripts/*.zig`          | The Zig sources for `bridge.wasm` and `canvas-compose.wasm`.                                                                                                                         |
| `bench/`, `scripts/`     | Benchmark entry points and their runners.                                                                                                                                            |
| `packages/`              | Workspace packages: `line-editor`, `shaders`.                                                                                                                                        |
| `demo/`                  | The local terminal lab.                                                                                                                                                              |
| `site/`, `site-classic/` | The Astro docs and landing sites. Their READMEs say how to build them.                                                                                                               |

## Change the docs

The public docs live in three places.

- `README.md` is rendered by npm, so every link and image in it is an absolute HTTPS URL. Its `ts` fence is type-checked against the built declarations by `bun run --cwd ghostty-webgpu/site docs:check`.
- `site/src/content/docs/` holds the tutorials and guides on [ghostty.shaulavo.dev](https://ghostty.shaulavo.dev/docs/). Put code in `site/src/examples/` and show it with `Code`. The checker rejects handwritten `ts` fences. See the [site README](../site/README.md).
- `docs/` holds reference, concepts, and decision records.

Two generated pieces are locked. `docs/benchmarks.md` and the README table between `## Performance` and `### Correctness` come from `docs/benchmarks/mac-m1-2026-10-10/scores.json`. Edit the data or `report.mjs`, then run `node docs/benchmarks/mac-m1-2026-10-10/report.mjs`. `report.mjs --check` fails when either file drifts.

From the repository root, `bun scripts/check-package-pages.mjs` checks the package manifest, including the homepage, which must stay `https://ghostty.shaulavo.dev/`.

## Benchmark tooling

- [Upload byte counters](benchmark-tracing.md) defines the WebGPU trace fields.
- [Comparison runtime provenance](comparison-provenance.md) shows how to build a comparison bundle against a past commit with `--runtime-ref`.
- [Terminal comparison benchmarks](benchmarks.md) holds the published results and how to recompute them.
