import type { APIRoute } from 'astro'

export const GET: APIRoute = () =>
  new Response(
    `# ghostty-webgpu

Ghostty's terminal core in the browser, with WebGPU, WebGL2, Canvas 2D and DOM renderers.

## Documentation

- [Start here](https://shaullavo.github.io/ghostty-webgpu/docs/)
- [First terminal](https://shaullavo.github.io/ghostty-webgpu/docs/start/quick-start/)
- [Coming from xterm.js](https://shaullavo.github.io/ghostty-webgpu/docs/start/xterm/)
- [PTY connection](https://shaullavo.github.io/ghostty-webgpu/docs/guides/pty/)
- [Worker entry](https://shaullavo.github.io/ghostty-webgpu/docs/guides/workers/)
- [Benchmarks](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/benchmarks.md)
- [Markdown sources](https://github.com/ShaulLavo/fregat/tree/main/ghostty-webgpu/site/src/content/docs/docs)
`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  )
