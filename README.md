# ghostty-webgpu

Development happens in the [Fregat monorepo](https://github.com/ShaulLavo/fregat/tree/main/ghostty-webgpu).
This repository mirrors its `ghostty-webgpu/` folder. Submit changes to Fregat.

an unofficial ghostty for the web, inspired by [ghostty-web](https://github.com/coder/ghostty-web) and powered by libghostty-vt

damage-aware rendering with webgpu, webgl2, canvas2d, and dom fallbacks. byte-based pty traffic, automatic fitting, and live themes

still a preview.

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

## first frames and damage

`renderFrameToHtml(snapshot, { font, columns, rows, theme })` produces the DOM backend's
cell runs as HTML under Node or in a browser. `snapshotRenderState(renderState)` reads an
immutable styled snapshot from the core. Cell geometry can be supplied through the inherited
`--ghostty-cell-width`, `--ghostty-cell-height`, `--ghostty-font-size`, and
`--ghostty-letter-spacing` CSS properties.

`terminal.onFrame(({ rows }) => …)` reports the viewport rows painted by each frame across
all backends. It returns a subscription with `dispose()`, like `onResize`; no damage array is
allocated when there are no listeners.

Resizing inside a frame callback repaints after that frame's callbacks finish, in the same turn.

## GPU frame ownership

WebGL and WebGPU use the Zig/WASM frame builder. It walks native terminal state and writes
persistent cell and glyph records; JavaScript rasterizes missing browser-font glyphs and uploads
only changed byte ranges. GPU sources provide `createFrameBuilder`.

Atlas recovery is bounded to three registration sweeps. If a frame still cannot be built, the
renderer reports a `frame_builder` error, retains the last submitted frame, and keeps damage and
refresh requests pending. The next write, resize, font change, explicit refresh or cursor activity
requests a full native rebuild. Recovery adds no failure-specific retry loop. Canvas resizing and
context replacement still invalidate prior pixels.

Canvas 2D, DOM, accessibility, selection/copy and frame callbacks retain their shared row readers.
Styled snapshots and text-only rows describe those consumers; GPU rendering reads native records.

## more

- [pty wiring and the native api](docs/integration.md)
- [font geometry and Canvas comparison](docs/font-geometry.md)
- [live demo](https://shaullavo.github.io/ghostty-webgpu/), built from [site/](site/) with `bun run site:dev`
- [optional native ghostty config](docs/config-resolver.md)
