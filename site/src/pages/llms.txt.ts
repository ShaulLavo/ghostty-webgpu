import type { APIRoute } from 'astro'

export const GET: APIRoute = ({ site }) =>
  new Response(
    `# ghostty-webgpu

Unpatched libghostty-vt compiled to WebAssembly, paired with a browser host and four renderers: WebGPU, WebGL2, Canvas 2D, and DOM.

## Documentation

- [Overview](https://ghostty.shaulavo.dev/docs/)
- [First terminal](https://ghostty.shaulavo.dev/docs/start/quick-start/)
- [A real shell in the browser](https://ghostty.shaulavo.dev/docs/start/real-shell/)
- [Coming from xterm.js](https://ghostty.shaulavo.dev/docs/start/xterm/)
- [Coming from ghostty-web](https://ghostty.shaulavo.dev/docs/start/ghostty-web/)
- [Connect to a PTY](https://ghostty.shaulavo.dev/docs/guides/pty/)
- [Renderers and fallbacks](https://ghostty.shaulavo.dev/docs/guides/renderers/)
- [Run in a worker](https://ghostty.shaulavo.dev/docs/guides/workers/)
- [Load fonts and fit the grid](https://ghostty.shaulavo.dev/docs/guides/fonts/)
- [Themes and Ghostty config](https://ghostty.shaulavo.dev/docs/guides/themes/)
- [Terminal hotkeys](https://ghostty.shaulavo.dev/docs/guides/hotkeys/)
- [Scrollback and history](https://ghostty.shaulavo.dev/docs/guides/scrollback/)
- [Terminal options](https://ghostty.shaulavo.dev/docs/reference/options/)
- [The wasm core](https://ghostty.shaulavo.dev/docs/concepts/how-it-works/)
- [Damage tracking](https://ghostty.shaulavo.dev/docs/concepts/damage-tracking/)
- [Benchmarks](https://ghostty.shaulavo.dev/docs/concepts/benchmarks/)
- [Echo terminal example](https://ghostty.shaulavo.dev/docs/examples/echo/)
- [Benchmark report](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks.md)
- [Correctness report](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/correctness.md)
- [Markdown sources](https://github.com/ShaulLavo/ghostty-webgpu/tree/main/site/src/content/docs/docs)
`.replaceAll(
      'https://ghostty.shaulavo.dev/',
      new URL(import.meta.env.BASE_URL.replace(/\/?$/, '/'), site).href,
    ),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  )
