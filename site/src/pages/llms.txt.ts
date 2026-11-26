import type { APIRoute } from 'astro'

export const GET: APIRoute = ({ site }) =>
  new Response(
    `# ghostty-webgpu

Unpatched libghostty-vt compiled to WebAssembly, paired with a browser host and four renderers: WebGPU, WebGL2, Canvas 2D, and DOM.

## Learn

- [Overview](https://ghostty.shaulavo.dev/docs/)
- [Quick start](https://ghostty.shaulavo.dev/docs/start/quick-start/)
- [Connect a real shell](https://ghostty.shaulavo.dev/docs/start/real-shell/)
- [Interactive echo demo](https://ghostty.shaulavo.dev/docs/examples/echo/)

## Guides

- [Wire a PTY](https://ghostty.shaulavo.dev/docs/guides/pty/)
- [Renderers & fallbacks](https://ghostty.shaulavo.dev/docs/guides/renderers/)
- [Run in a worker](https://ghostty.shaulavo.dev/docs/guides/workers/)
- [Fonts & grid sizing](https://ghostty.shaulavo.dev/docs/guides/fonts/)
- [Themes & Ghostty config](https://ghostty.shaulavo.dev/docs/guides/themes/)
- [Keyboard & hotkeys](https://ghostty.shaulavo.dev/docs/guides/hotkeys/)
- [Scrollback & history](https://ghostty.shaulavo.dev/docs/guides/scrollback/)

## Migration

- [From xterm.js](https://ghostty.shaulavo.dev/docs/start/xterm/)
- [From ghostty-web](https://ghostty.shaulavo.dev/docs/start/ghostty-web/)

## Architecture & Reference

- [How the WASM core works](https://ghostty.shaulavo.dev/docs/concepts/how-it-works/)
- [Per-cell damage tracking](https://ghostty.shaulavo.dev/docs/concepts/damage-tracking/)
- [Benchmarks](https://ghostty.shaulavo.dev/docs/concepts/benchmarks/)
- [Options reference](https://ghostty.shaulavo.dev/docs/reference/options/)
- [Full benchmark report](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks.md)
- [Correctness report](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/correctness.md)
- [Markdown sources](https://github.com/ShaulLavo/ghostty-webgpu/tree/main/site/src/content/docs/docs)
`.replaceAll(
      'https://ghostty.shaulavo.dev/',
      new URL(import.meta.env.BASE_URL.replace(/\/?$/, '/'), site).href,
    ),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  )
