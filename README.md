[![ghostty-webgpu rendering the ghost demo](docs/images/terminal.webp)](https://shaullavo.github.io/ghostty-webgpu/)

# ghostty-webgpu

an unofficial ghostty for the web, inspired by [ghostty-web](https://github.com/coder/ghostty-web) and powered by libghostty-vt

damage-aware rendering with webgpu, webgl2, canvas2d, and dom fallbacks. still a preview

## try it

[open the live demo](https://shaullavo.github.io/ghostty-webgpu/)

```sh
npm install ghostty-webgpu
```

```html
<div id="terminal" style="height: 32rem; width: 100%"></div>
```

```ts
import { Terminal } from 'ghostty-webgpu'

const host = document.getElementById('terminal')!
const terminal = await Terminal.create()
await terminal.open(host)
terminal.write('hello from ghostty\r\n')
terminal.focus()
```

call `terminal.dispose()` when you're done. [connect a websocket pty](docs/integration.md) for a real shell

## what's in it

- redraws only changed cells, with gpu rendering and canvas and dom fallbacks
- byte-based pty traffic, automatic fitting, and live themes
- selection, scrollback, links, and unicode text

## benchmarks

recorded october 1, 2026 on an apple m1 in chromium, one terminal receiving bytes. parser throughput; higher is better

| input    | ghostty-webgpu | xterm.js webgl | ghostty-web |
| -------- | -------------: | -------------: | ----------: |
| ascii    |    164.36 MB/s |     63.55 MB/s |  65.58 MB/s |
| git logs |    360.42 MB/s |     69.67 MB/s |  65.71 MB/s |

[method and full results](docs/benchmarks.md), including latency, cpu, and memory

## more

[pty wiring](docs/integration.md) · [api, workers, and rendering](docs/api.md) · [fonts](docs/font-geometry.md) · [hotkeys](docs/hotkeys.md) · [native config](docs/config-resolver.md)

development happens in [fregat](https://github.com/ShaulLavo/fregat/tree/main/ghostty-webgpu). this repo mirrors its `ghostty-webgpu/` folder; submit changes there

ghost artwork from [ghostty.org](https://ghostty.org), used under its mit license
