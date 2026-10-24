# ghostty-webgpu site

The landing page and Starlight docs build together. Every visit draws one of ascii.rest's colour scenes in a ghostty-webgpu terminal, and the whole site takes that scene's colours (`src/scene/`). The landing page's sections are ascii.rest pieces in those colours (`src/scene/art.ts`); the docs keep the tab's scene through `SceneTheme.astro` and `src/styles/docs-theme.css`. Add `?scene=<name>` to any page to pin a scene.

## Build from the workspace

```sh
bun install --frozen-lockfile
bun run --cwd hotkeys/packages/hotkeys build
bun run --cwd ghostty-webgpu build
bun run --cwd ghostty-webgpu/site build
```

Run these from the Fregat root. The build checks examples, generates the API reference from `ghostty-webgpu/dist/**/*.d.ts`, validates internal links and builds Pagefind search. `--base /fregat/ghostty-webgpu/` builds the same docs under a different hosting path.

The docs workspace pins TypeScript 6.0.3 for TypeDoc's JavaScript compiler API. Example checks use the package compiler and the built declarations. Package builds stay on the root TypeScript version.

The shared `scripts/package-aliases.ts` resolves browser examples to the built package entry points in both the monorepo and standalone mirror.

## Write a page

Pages live in `src/content/docs/docs/`. Put executable TypeScript examples in `src/examples/`, import their source with `?raw`, and display it with Starlight's `Code` component. The example checker rejects handwritten JavaScript and TypeScript fences so displayed code always comes from a checked module. It also extracts and compiles the package README's executable fences. The API currently has no TSDoc `@example` blocks.

Use absolute published docs URLs in authored Markdown so links work in the mirror. `scripts/docs-links.ts` rewrites those URLs to the active build base before link validation. Generated reference links follow the base chosen by Starlight TypeDoc.

The `ghostty docs` workflow builds pull requests touching the package, site or dependencies. It checks docs and the echo terminal at desktop and phone widths, then exercises Pagefind search. `docs:check` also runs the real PTY example on a free port, checking binary output, resize and the tutorial's input guards. The Worker publishes this edition. The mirror’s Pages workflow publishes `../site-classic`, which reads these same docs and examples through relative symlinks. Engineering notes remain under the package's repository docs directory.

## Preview locally

```sh
bun run --cwd ghostty-webgpu/site preview --ignore-lock --host 127.0.0.1 --port 4327
```

Choose a free port and stop the server when done. The echo component uses the same checked module shown on the quick-start page. Its fallback text remains readable when JavaScript is disabled.
