# Troubleshooting

Find your symptom, check the cause, apply the fix. Each entry names the source that backs it.

## The terminal is blank or has no rows

**Cause.** The host element has no size. The fitter returns no grid when the host's content box is zero wide or zero tall, after padding and scrollbar width (`src/dom/fit.ts`). A flex child often reports zero height.

**Fix.** Give the host a height and width before you call `open()`. In a flex layout, add `min-height: 0` to the child so its parent sets the size.

```html
<div id="terminal" style="height: 20rem; width: 100%"></div>
```

## The browser fails to load a `.wasm` file

**Cause.** The package resolves `ghostty-vt.wasm`, `bridge.wasm`, `canvas-compose.wasm`, and `canvas-compose-scalar.wasm` relative to its own module URL (`src/core/assets.ts`). A bundler that does not copy those files leaves 404s in the network panel. The server must also send `application/wasm`.

**Fix.** Make your bundler emit the asset files next to the package output, and serve `.wasm` as `application/wasm`. The worker entry can also load hosted copies through its `assets` and `workerUrl` options. `canvas-compose.wasm` loads only in `canvas2d-pixels` mode. The [worker guide](https://ghostty.shaulavo.dev/docs/guides/workers/) lists the files, and [use in your own app](use-in-your-app.md#ship-the-wasm-files) shows the Vite and `bun build` results.

## You do not know which renderer is running

**Cause.** `Terminal.create()` picks a renderer for the browser and falls through on failure. WebGPU needs a hardware adapter, and desktop Linux tries WebGL2 first.

**Fix.** Read `terminal.diagnostics.rendererBackend` after `open()`. It is `'webgpu'`, `'webgl2'`, `'canvas2d'`, or `'dom'`. To change the choice, read [the renderer order](concepts.md#four-renderers-and-the-order-they-are-tried) and the [renderers guide](https://ghostty.shaulavo.dev/docs/guides/renderers/).

## Typing shows nothing

**Cause.** The terminal does not echo. `onData` emits an event whose `bytes` a PTY expects, and a shell echoes them back. With no PTY, nothing writes the keys to the screen. The terminal also needs focus.

**Fix.** Call `terminal.focus()` after `open()`. Send `onData` event bytes to your PTY and `write()` its output back. For a quick local check, write the bytes back yourself, as the [first-terminal tutorial](https://ghostty.shaulavo.dev/docs/start/quick-start/) does.

## A ZWJ emoji takes four or eight cells

**Cause.** Grapheme clustering is terminal mode 2027, and it is off by default. In that state Ghostty counts each codepoint of a ZWJ sequence.

**Fix.** Have the program write `\x1b[?2027h` to turn it on. `\x1b[?2027l` restores the default. See [ZWJ emoji and grapheme widths](integration.md#zwj-emoji-and-grapheme-widths).

## A program's clipboard write does nothing

**Cause.** The terminal denies OSC 52 clipboard writes unless the host sets a policy. OSC 52 reads receive no reply.

**Fix.** Pass a `clipboardWrite` policy to `Terminal.create()`. The policy returns a result such as `'denied'`, or a decision with a `completion` promise (`src/dom/clipboard.ts`). The [options reference](https://ghostty.shaulavo.dev/docs/reference/options/) lists it.

## Scrollback keeps fewer rows than `scrollbackLimit`

**Cause.** Ghostty prunes whole pages, not single rows. The retained count can fall below the limit. Small values, including zero, can keep more rows than set, because the budget always allows one standard page.

**Fix.** Read the real count with `lineCount()` instead of assuming the limit. The rules are in [scrollback retention](api.md#scrollback-retention).

## Drawing on `terminal.canvas` disappears

**Cause.** The renderer owns `terminal.canvas` and its 2D context. Drawing into it is unsupported, and the next frame overwrites it.

**Fix.** Draw overlays on a separate canvas or DOM element placed over the terminal. See [canvas and link cursors](api.md#canvas-and-link-cursors).

## Importing `ghostty-webgpu/config-resolver` breaks a client bundle

**Cause.** The subpath is host-only. It uses Node or Bun APIs and native binaries, and it is unavailable to browsers.

**Fix.** Import it only in server code, and mark it external in server bundles. See [config resolver](config-resolver.md).

## Still stuck

Search the [issues](https://github.com/ShaulLavo/fregat/issues). When you file one, include the version from `package.json`, the browser, `terminal.diagnostics.rendererBackend`, and a minimal reproduction.
