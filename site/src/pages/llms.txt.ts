import type { APIRoute } from 'astro'

export const GET: APIRoute = ({ site }) =>
  new Response(
    `# ghostty-webgpu

Ghostty's terminal core in the browser, with WebGPU, WebGL2, Canvas 2D and DOM renderers.

## Documentation

- [Start here](https://ghostty.shaulavo.dev/docs/)
- [First terminal](https://ghostty.shaulavo.dev/docs/start/quick-start/)
- [Coming from xterm.js](https://ghostty.shaulavo.dev/docs/start/xterm/)
- [PTY connection](https://ghostty.shaulavo.dev/docs/guides/pty/)
- [Worker entry](https://ghostty.shaulavo.dev/docs/guides/workers/)
- [Benchmarks](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/benchmarks.md)
- [Markdown sources](https://github.com/ShaulLavo/fregat/tree/main/ghostty-webgpu/site/src/content/docs/docs)
`.replaceAll(
      'https://ghostty.shaulavo.dev/',
      new URL(import.meta.env.BASE_URL.replace(/\/?$/, '/'), site).href,
    ),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  )
