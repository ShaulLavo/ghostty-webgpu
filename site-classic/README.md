# Classic ghostty-webgpu site

The original Ghost, Matrix and Shell landing page and Mist-themed Starlight docs publish to [GitHub Pages](https://shaullavo.github.io/ghostty-webgpu/). The [scene edition](https://ghostty.shaulavo.dev/) builds from `../site` and keeps its Worker deployment.

## Build

From the Fregat root:

```sh
bun install --frozen-lockfile
bun run --cwd hotkeys/packages/hotkeys build
bun run --cwd ghostty-webgpu build
bun run --cwd ghostty-webgpu/site-classic build --base /ghostty-webgpu/
```

The build checks types, shared docs examples, PTY and Worker tests, classic first-frame and fit tests, API links and Pagefind search. The mirror's Pages workflow calls `site:classic:build` and publishes `site-classic/dist`. The mirror job splits the entire `ghostty-webgpu/` tree, including both site folders and their relative symlinks.

## Shared docs

Edit pages in `../site/src/content/docs`, examples in `../site/src/examples`, and the echo component in `../site/src/components/EchoTerminal.astro`. Relative symlinks read these sources directly. Measurements, correctness and site links also use the scene site's source. The classic-specific fonts, styles, landing components and demos stay here.

Author links as `https://ghostty.shaulavo.dev/docs/…`. The shared docs-links integration rewrites these URLs to the active base before Starlight validates links, so Pages readers stay on the classic site. API references are generated from the package's built declarations. Both sites use the shared docs checker. Build them sequentially because TypeDoc writes reference pages into the shared content directory; the workspace task graph enforces that order.

## Preview locally

```sh
bun run --cwd ghostty-webgpu/site-classic preview --ignore-lock --host 127.0.0.1 --port 4327
```

Choose an available port and stop the preview when done. The docs keep the Mist palette, Bricolage Grotesque and JetBrains Mono fonts, and Starlight's light/dark switch.
