# ghostty-webgpu

`ghostty-webgpu` is a browser terminal built on the unpatched libghostty-vt WebAssembly runtime.
It includes native terminal parsing and input encoding, selection and link handling, automatic DOM
fit, accessibility support, and a damage-aware WebGPU renderer with no standing animation loop.

This is an independent, unofficial project. It is not affiliated with or endorsed by the Ghostty
project. Ghostty's upstream code and contributors are credited in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

It is not an xterm.js drop-in replacement. The renderer borrows proven geometry and atlas ideas
from xterm.js's WebGL renderer, while the terminal model, lifecycle, input surface, and public API
remain native to this package and libghostty-vt.

The package is dist-first: JavaScript and declarations are exported from `dist`, and the checked-in
`ghostty-vt.wasm` and `bridge.wasm` artifacts ship at the package root. Consumers do not need Zig.
Importing the package does not touch the DOM or install browser listeners.

## Install

The package is not published to npm yet. Build the current source with Bun:

```bash
git clone https://github.com/ShaulLavo/ghostty-webgpu.git
cd ghostty-webgpu
bun install --frozen-lockfile
bun run build
```

The browser host needs WebGPU and a parent element with a non-zero size:

```html
<div id="terminal"></div>
```

```css
#terminal {
  height: 30rem;
  width: 100%;
}
```

## Browser terminal

Create the terminal, open it once in a host element, and keep PTY traffic as bytes:

```ts
import { GhosttyWebGpuTerminal } from 'ghostty-webgpu'

const host = document.querySelector<HTMLElement>('#terminal')
if (!host) throw new TypeError('Terminal host is missing')

const terminal = await GhosttyWebGpuTerminal.create({
  accessibility: { label: 'Remote shell' },
  appearance: {
    cursor: { blink: false },
    font: {
      boldWeight: 700,
      family: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      size: 14,
      weight: 400,
    },
    scrollbackLimit: 10_000,
  },
  links: {
    activateUri(uri) {
      const target = new URL(uri)
      if (target.protocol !== 'https:') return
      window.open(target, '_blank', 'noopener,noreferrer')
    },
  },
  padding: 8,
})

await terminal.open(host)

const socketUrl = new URL('/pty', window.location.href)
socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const socket = new WebSocket(socketUrl)
socket.binaryType = 'arraybuffer'

function sendResize(cols: number, rows: number): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'resize', cols, rows }))
}

const dataSubscription = terminal.onData((bytes) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(bytes)
})
const resizeSubscription = terminal.onResize(({ cols, rows }) => sendResize(cols, rows))

socket.addEventListener('open', () => {
  const grid = terminal.appearance.grid
  sendResize(grid.columns, grid.rows)
  terminal.focus()
})
socket.addEventListener('message', (event) => {
  if (!(event.data instanceof ArrayBuffer)) return
  terminal.write(new Uint8Array(event.data))
})

function dispose(): void {
  dataSubscription.dispose()
  resizeSubscription.dispose()
  socket.close()
  terminal.dispose()
}

window.addEventListener('pagehide', dispose, { once: true })
```

`onData` receives owned `Uint8Array` values from keyboard, IME, paste, focus, mouse, and terminal
query replies. Send those bytes to the PTY without decoding and re-encoding them. Feed PTY output
to `write()` as bytes for the same reason. `onResize` reports the committed `{ cols, rows }` after
the native terminal and renderer have been resized.

The generic `on()` method also exposes `appearance`, `bell`, `error`, `scroll`, `selection`, and
`title` events. Every subscription has an idempotent `dispose()` method.

## Lifecycle and runtime ownership

`GhosttyWebGpuTerminal.create()` creates the native session but does not attach DOM. `open(parent)`
is asynchronous and one-shot. It preserves the parent's existing children, styles, and attributes,
and appends one package-owned root. Methods that operate on an interactive terminal require the
lifecycle to be `open`.

`dispose()` is idempotent. It invalidates an in-flight open and removes the owned DOM, listeners,
observers, pending fit work, selection autoscroll, scrollbar fade, renderer, native terminal, and
other owned resources. Browser WebGPU adapter/device acquisition is not abortable; if one is
outstanding, `open()` rejects and disposes its result when the request settles. A disposed terminal
cannot be reopened.

By default, each terminal owns a `GhosttyRuntime`, and disposing the terminal disposes that runtime.
To share one wasm instance, borrow an explicitly created runtime:

```ts
import { GhosttyRuntime, GhosttyWebGpuTerminal } from 'ghostty-webgpu'

const runtime = await GhosttyRuntime.create()
const left = await GhosttyWebGpuTerminal.create({
  runtime: { kind: 'borrowed', runtime },
})
const right = await GhosttyWebGpuTerminal.create({
  runtime: { kind: 'borrowed', runtime },
})

// Open and use both terminals.

left.dispose()
right.dispose()
runtime.dispose()
```

A borrowed runtime is never disposed by a terminal. Dispose every borrowing terminal before the
runtime itself.

PNG decoding is a libghostty-vt global within a wasm instance, not a per-terminal option. Pass the
synchronous `decodePng: (bytes) => DecodedPng | undefined` callback to `GhosttyRuntime.create()`
before creating a terminal. Every terminal borrowing that runtime uses the same decoder;
reconfiguration is rejected while any terminal is alive. A decoded image needs positive integer
dimensions and exactly `width * height * 4` RGBA8 bytes, which the bridge copies synchronously.

`GhosttyRuntime.create()` resolves the committed wasm artifacts relative to the package by default.
Its `wasm` and `bridge` options also accept URLs, strings, `WebAssembly.Module` values, or bytes.

## Fit and device-pixel ratio

The DOM host fits automatically. It observes its owned root, loaded fonts, window size, and
device-pixel-ratio changes, and coalesces them into at most one pending fit frame. It measures the
configured font, subtracts terminal padding and scrollbar width, and commits one grid to both the
native terminal and renderer. A zero-sized content box, such as a `display: none` host, produces no
invalid resize; fitting resumes when an observed layout change gives it usable space.

Cell dimensions in `terminal.appearance.grid` are CSS-logical values. Font fitting first floors the
measured character advance and rounds letter spacing in device pixels, then derives cell height,
character offsets, baseline, and CSS dimensions from that one integer device grid. Canvas backing
dimensions, pointer projection, selection geometry, glyph placement, and the native terminal
therefore agree at fractional DPR without accumulating row or column drift. Calling `setFont()`
triggers measurement and refit; callers do not need to resize the renderer separately.

Font defaults are `monospace`, size `14`, line height `1.2`, letter spacing `0`, regular weight
`400`, and bold weight `700`. Numeric weights accept integers from `1` through `1000`; line height
must be at least `1`, and negative letter spacing is accepted only while the fitted device cell
width remains positive.

## Renderer architecture

Populated frames use exactly two instanced WebGPU draws. The first pass owns fixed-cell effects:
explicit backgrounds, cursor shapes, underlines, overlines, and strikes. The second pass draws
bearing-aware glyph quads cropped to their actual ink bounds, with regular, bold, italic, and
bold-italic identity kept in the glyph cache.

Grayscale and color glyphs live in separate fixed-size WebGPU texture arrays. Atlas mutations
upload only dirty rectangles, texture views and bind groups remain stable, and recycled layers use
generation-safe row invalidation. Rendering remains damage-driven with no standing animation loop.
The architectural alignment with xterm.js stops at these renderer principles; constructor options,
events, addons, terminal state, and compatibility behavior are not xterm.js APIs.

## Link policy

Link discovery resolves native OSC 8 hyperlinks first, registered providers second, and built-in
`http://` and `https://` text last. Discovery never navigates by itself. OSC 8 and detected URLs are
activated only when `links.activateUri` is configured; validate the URI there before handing it to
browser or application navigation.

Pointer activation requires Command-click on Apple platforms and Control-click elsewhere by
default. Supply `linkActivationModifier` to change that policy. `registerLinkProvider()` adds an
application provider whose cell ranges can carry their own activation callback; dispose the
returned registration when it is no longer valid. Writes, resize, scroll, and content-changing
frames invalidate stale provider results. Provider and activation failures are reported through
the terminal's `error` event.

## Clipboard policy

User paste always passes through libghostty-vt's native paste encoder. On Apple platforms,
Command-C with a native selection calls the owning window's `navigator.clipboard.writeText()`
directly from that keydown gesture. On other platforms, Control-C remains terminal input; an
embedding application can provide its own menu or gesture by reading `getSelection()`. Supply
`copySelection` to replace the built-in Apple copy action while preserving its user-gesture
boundary.

Terminal-initiated clipboard writes such as OSC 52 are denied by default. Opt in explicitly with a
`clipboardWrite` policy:

```ts
import { GhosttyWebGpuTerminal } from 'ghostty-webgpu'

const decoder = new TextDecoder()

const terminal = await GhosttyWebGpuTerminal.create({
  clipboardWrite(write) {
    const plainText = write.contents.find((entry) => entry.mime.startsWith('text/plain'))
    if (!plainText) return 'unsupported'
    const completion = navigator.clipboard.writeText(decoder.decode(plainText.data))
    return { completion, result: 'success' }
  },
})
```

The policy receives copied MIME bytes and a `standard`, `selection`, or `primary` location. Its
synchronous result reports policy acceptance, denial, or lack of support; `success` does not claim
that an asynchronous browser write has completed. Pass that work as `completion`. A rejection is
emitted as an `error` event with operation `clipboardWrite.completion`. Browser permissions and
user-activation rules commonly reject OSC 52 writes even after application opt-in.

## Accessibility

Accessibility support is installed with the DOM host. A visually hidden textarea owns keyboard
and IME focus and defaults to the label `Terminal input`; customize it with
`accessibility.label`. A visually offscreen, screen-reader-visible mirror exposes the current
viewport as stable list rows, tracks the cursor row, and updates after successful renderer frames.

New terminal output is announced through a bounded polite live region instead of repeatedly
announcing the full scrollback. `accessibility.liveRegionMaxEntries` and
`accessibility.liveRegionMaxCharacters` configure its limits. Disposal removes the mirror, cursor
status, live region, and their ARIA references.

## Scheduling and idle behavior

Rendering is damage-driven. Repeated wake-ups coalesce into one pending `requestAnimationFrame`,
and libghostty-vt damage is acknowledged only after a successful GPU submission. The renderer does
not run a perpetual frame loop. Fit and link resolution react to observed changes. Selection
autoscroll holds a temporary interval only during a captured out-of-bounds drag, and scrollbar fade
holds one bounded timeout after interaction.

A native cursor that is visible, inside the viewport, configured to blink, focused, and in a visible
document holds one timeout between blink transitions; it still does not hold a standing rAF. After
transient interaction work settles, disabling blink, unfocusing the terminal, or hiding the
document clears that blink timer. Inspect
`terminal.diagnostics.hasPendingFrame`, `hasPendingTimer`, and `hasPendingLinkResolution` when an
embedding needs to assert quiescence.

## Lower-level renderer API

Browser applications that own orchestration can use the low-level native core and WebGPU renderer
directly:

```ts
import { fitTerminalFont, GhosttyRuntime, WebGpuTerminalRenderer } from 'ghostty-webgpu'

const runtime = await GhosttyRuntime.create()
const font = fitTerminalFont(
  document,
  {
    boldWeight: 700,
    family: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    letterSpacing: 0,
    lineHeight: 1.2,
    size: 14,
    weight: 400,
  },
  window.devicePixelRatio,
)
const terminal = runtime.createTerminal({
  cellHeight: font.deviceCellHeight,
  cellWidth: font.deviceCellWidth,
  columns: 80,
  rows: 24,
})
const renderState = runtime.createRenderState(terminal)
const canvas = document.querySelector<HTMLCanvasElement>('#terminal-canvas')
if (!canvas) throw new TypeError('Terminal canvas is missing')

const renderer = await WebGpuTerminalRenderer.create({
  canvas,
  columns: 80,
  font,
  renderState,
  rows: 24,
})

terminal.write('\u001b[32mready\u001b[0m')
renderer.notifyWrite()

function dispose(): void {
  renderer.dispose()
  renderState.dispose()
  terminal.dispose()
  runtime.dispose()
}

window.addEventListener('pagehide', dispose, { once: true })
```

The low-level renderer requires a fitted-font value and accepts only rows and columns in `resize()`.
Call `fitTerminalFont()` again after a font or DPR change, pass the result to `renderer.setFont()`,
and resize the native terminal with the fitted device-cell dimensions. The lower-level renderer
does not install DOM input, automatic fit, link, clipboard, selection, scrollbar, or accessibility
integration. The embedding application owns those wake-ups and lifecycle edges.

## Development

```bash
bun install
bun run verify
```

The verification gate runs browser-independent tests plus real Chromium WebGPU readback tests.
Run them separately with `bun run test:unit` and `bun run test:browser`.

The headed hardware benchmark measures focused idle, unfocused idle, burst output, sustained
scroll, and glyph churn at 200×50 and DPR 2:

```bash
bun run bench:renderer
```

Rebuild both wasm artifacts from the pinned Ghostty revision:

```bash
bun run build:wasm
```

For a previously checked-out source tree at the exact pin:

```bash
bun run build:wasm -- --source /path/to/ghostty
```

The build uses Ghostty revision `da5ddcb0857c0e4ddb32f7a089911e9038d040f3` and its unmodified
`zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall` target. This pin
requires Zig 0.16.0 or newer; pass `--zig /path/to/zig` to select a specific binary.
