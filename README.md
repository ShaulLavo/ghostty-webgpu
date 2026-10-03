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

`TerminalApi<'sync'>` describes this main-thread entry. `TerminalApi<'async'>` describes the
worker return convention: authoritative operations return promises with the same arguments.
The default `TerminalApi` accepts both conventions for await-style common callers. Host DOM,
subscriptions, focus and displayed text stay synchronous; `open()` and `focusNextLink()` already
return promises in the main entry. The packaged worker entry follows separately.

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

`terminal.submittedFrame` is the owned, text-only state of the last submitted frame. Its frame,
native revision, snapshot version and layout identity accompany the grid, fitted font, padding,
theme, cursor, selection coordinates, scrollbar and visible row text. The value appears after the
first submission and holds together while new output or layout is pending. `rows` contains the
whole visible text viewport; `rowPatches` contains changed row text, with every row included when
the layout changes. Both can be structured-cloned.

Each text-frame submission owns its row text. Styled cells remain an on-demand read through
`frameSnapshot()` and `captureViewport()`. A capture is available only while the native revision,
render snapshot and layout still match the submission. Canvas resizing and context replacement
can invalidate the displayed pixels independently of the retained submitted state.

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

## comparisons

From this package, use `bun run bench:compare -- --headed --bundle /path/to/bundle`
for headed hardware Chromium measurements. A built bundle accepts
`node comparison-runner.mjs --headed --output results`.

`--headed` selects the browser window independently of `--smoke`, which selects
correctness checks. Defaults remain headless on Linux and headed on macOS for
hardware measurements; smoke runs default to headless on both.

## live geometry and text width

`terminal.geometry()` samples the current native columns, rows, cursor, pending wrap,
scrollbar, autowrap and grapheme-clustering mode. Cell dimensions are CSS pixels. Its revision
identifies the execution owner's state. `visibleLines()` continues to describe submitted text.

`terminal.measure(text)` returns the sum of native printing-unit cell widths.
`terminal.measureTexts(texts)` measures a readonly batch against one live geometry sample and
returns UTF16 source ranges and cell widths for each printing unit. Mode 2027 selects native
grapheme clusters; with it disabled, units are codepoints. These methods accept plain printable
text, including combining marks and variation selectors. Empty text measures zero. VT controls,
newlines and tabs are rejected; this API measures widths and does not predict wrapping.

`terminal.writeAndReadGeometry(data)` writes through the native VT parser and captures the
resulting cursor and geometry before publishing output observers. A colored prompt can establish
its edit origin with this single operation. Observers may subsequently write more output; the
returned sample retains the prompt write's revision and cursor.

## more

- [pty wiring and the native api](docs/integration.md)
- [font geometry and Canvas comparison](docs/font-geometry.md)
- [live demo](https://shaullavo.github.io/ghostty-webgpu/), built from [site/](site/) with `bun run site:dev`
- [optional native ghostty config](docs/config-resolver.md)
