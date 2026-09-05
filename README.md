# ghostty-webgpu

an unofficial ghostty for the web, inspired by [ghostty-web](https://github.com/coder/ghostty-web) and powered by libghostty-vt

damage-aware rendering with webgpu, webgl2, and canvas2d fallbacks. byte-based pty traffic, automatic fitting, and live themes

still a preview. [compatibility gaps and migration status](docs/replacement/README.md)

## try it

```sh
npm install ghostty-webgpu
```

give it somewhere to live

```html
<div id="terminal" style="height: 32rem; width: 100%"></div>
```

```ts
import { Terminal } from 'ghostty-webgpu'

const host = document.getElementById('terminal')
if (!host) throw new Error('missing terminal mount')

const terminal = await Terminal.create()
await terminal.open(host)
terminal.write('hello from ghostty\r\n')
terminal.focus()
```

call `terminal.dispose()` when you're done with it

## more

- [pty wiring and the xterm-shaped api](docs/integration.md)
- [optional native ghostty config](docs/config-resolver.md)
- [replacement roadmap](plans/016-ghostty-web-replacement-readiness.md)
