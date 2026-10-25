# ghostty-webgpu

An unofficial browser terminal using Ghostty's unpatched WebAssembly core with WebGPU, WebGL2, Canvas 2D, and DOM renderers.

Build and run with Bun 1.4.4 and Node 20 or newer:

```sh
git clone https://github.com/ShaulLavo/ghostty-webgpu.git
cd ghostty-webgpu
bun install --frozen-lockfile
bun run build
bun run demo
```

Mount a `<div id="terminal" style="height: 32rem"></div>`, then:

```ts
import { Terminal } from 'ghostty-webgpu'

const terminal = await Terminal.create()
await terminal.open(document.getElementById('terminal')!)
terminal.write('hello from ghostty\r\n')
```

[Install in your app](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/use-in-your-app.md) · [Website and guides](https://ghostty.shaulavo.dev/) · [Development and releases](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/development.md) · [Overview and measurements](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/overview.md) · [MIT license](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/LICENSE)
