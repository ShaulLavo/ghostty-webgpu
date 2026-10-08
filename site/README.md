# ghostty-webgpu site

The custom landing page and Starlight docs build together. The landing page keeps its own stylesheet. `src/styles/docs.css` is the single place for docs styling changes; leave Starlight's theme defaults in place until the site design is chosen.

## Build from the workspace

```sh
bun install --frozen-lockfile
bun run --cwd hotkeys/packages/hotkeys build
bun run --cwd ghostty-webgpu build
bun run --cwd ghostty-webgpu/site build
```

Run these from the Fregat root. The build checks examples, generates the API reference from `ghostty-webgpu/dist/**/*.d.ts`, validates internal links and builds Pagefind search. `--base /fregat/ghostty-webgpu/` builds the same docs under a different hosting path.

The docs workspace pins TypeScript 6.0.3 for TypeDoc's JavaScript compiler API. Example checks use the root compiler and the built declarations. Package builds stay on the root TypeScript version.

## Write a page

Pages live in `src/content/docs/docs/`. Put executable TypeScript examples in `src/examples/`, import their source with `?raw`, and display it with Starlight's `Code` component. The example checker rejects handwritten JavaScript and TypeScript fences so displayed code always comes from a checked module. It also extracts and compiles the package README's executable fences and the landing page's two samples. The API currently has no TSDoc `@example` blocks.

Use absolute published docs URLs in authored Markdown so links work in the mirror. `scripts/docs-links.ts` rewrites those URLs to the active build base before link validation. Generated reference links follow the base chosen by Starlight TypeDoc.

The `ghostty docs` workflow builds pull requests touching the package, site or dependencies. It checks docs and the echo terminal at desktop and phone widths, then exercises Pagefind search. `docs:check` also runs the real PTY example on a free port, checking binary output, resize and the tutorial's input guards. The existing family-site workflow deploys the combined output. Engineering notes remain under the package's repository docs directory.

## Local review

```sh
bun run --cwd ghostty-webgpu/site preview --ignore-lock --host 127.0.0.1 --port 4327
```

Choose a free port and stop the server after review. The echo component uses the same checked module shown on the quick-start page. Its fallback text remains readable when JavaScript is disabled.
