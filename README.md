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
return promises in the main entry.

## packaged worker checkpoint

The `ghostty-webgpu/worker` entry creates the same DOM host around a dedicated worker.
The worker owns its native session, WASM, fitted font, Zig frame builder and WebGPU or WebGL
renderer. Supply each font as an explicit URL or byte array with optional `FontFaceDescriptors`.

```ts
import { Terminal } from 'ghostty-webgpu/worker'

const terminal = await Terminal.create({
  backend: 'webgl',
  fonts: [
    {
      family: 'JetBrains Mono',
      source: { url: new URL('./fonts/jetbrains-mono.woff2', import.meta.url).href },
    },
  ],
})
await terminal.open(host)
await terminal.write('hello from the worker\r\n')
const lines = await terminal.readLines(0, 1)
terminal.focus()
await terminal.dispose()
```

`backend` accepts `webgpu`, `webgl` or `auto`. Automatic selection checks worker GPU support
before choosing a context. Capability failures carry `code`, `operation`, `why`, `fix` and
runtime facts. `assets` and `workerUrl` can point at explicitly hosted native files and the
built standalone `dist/worker/entry.js`; the defaults resolve beside the package output.

Writes copy caller-owned bytes and keep their buffers attached. `attachOutputPort(port)`
transfers a producer port. Its `ready` message supplies terminal and generation identities;
producer `output` messages carry those identities, a sequence starting at one, and owned bytes.
The producer may transfer its owned buffer. `fenceOutput(sequence)` makes subsequent control
operations and disposal wait until the native actor has processed that sequence.

The compiled checkpoint covers output, authoritative reads, native key/text/paste encoding,
programmatic selection and scrolling, layout, submitted text, accessibility and lifecycle.
`geometry()`, `measure(text)`, `measureTexts(readonlyTexts)` and `writeAndReadGeometry(data)`
return promises backed by the same native owner as the main entry. The last operation captures
its geometry before publishing effects, preserving prompt origin across observer writes.
Pointer selection, clipboard shortcuts, links and extension hooks still need their leaf
integrations. Worker link-provider registration and keyboard link discovery currently report
structured capability errors. Worker Canvas requests report a structured capability failure.
Publication, full interaction parity and presentation acceptance wait for their integration gates.
Packaged-entry Chromium software-GPU checks qualify correctness only.
OSC 52 remains denied by default.

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

## Canvas paint modes

`Terminal.create({ rendererMode })` and `WebGpuTerminalRendererOptions.rendererMode`
select `auto`, `canvas2d-fill-text`, or `canvas2d-pixels`. The worker entry accepts `auto`
and reports a capability error for explicit Canvas modes. The two Canvas modes share native cell ownership, row damage, cursor
painting and scroll history. Text shaping stays inside each native owner, including the
terminal's mode-2027 grapheme spans.

The explicit pixel mode is experimental with correctness coverage. Headed visual calibration
and performance qualification are pending. It lazily loads
`canvas-compose.wasm` into independent ordinary WASM memory. Browser rasterization runs on
stamp-cache misses: the existing glyph model supplies A8 coverage or intrinsic-color RGBA,
and paths supply A8 coverage. The viewport-bounded cache retains offsets, and one straight
RGBA8 framebuffer aliases the `ImageData` submitted for coalesced dirty rows. The default
fillText mode performs no compositor download, compilation or framebuffer allocation.

Composition quantizes after each operation. Effective alpha is nearest-integer
`sourceAlpha * opacity / 65535`; A8 additionally includes `coverage / 255` in that same
rounding operation. For effective alpha `a`, destination alpha `d`, and source/destination
straight color channels `s` and `c`, the denominator is `a * 255 + d * (255 - a)`.
Output color is nearest-integer `(s * a * 255 + c * d * (255 - a)) / denominator`, and
output alpha is nearest-integer `denominator / 255`. Half ties round upward, zero effective
alpha preserves all destination bytes, and clear writes RGBA zero. Scalar and SIMD tests
compare this contract exactly; retained-f32 comparisons report quantization error separately.

Rebuild the checked-in compositor with `bun run build:canvas-compose`, using Bun and Zig
0.16.0 or newer. `--scalar --output <file>` builds the independent scalar test arm. This
Canvas-local asset changes neither the pinned native Ghostty build nor its ABI.

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

## extensions and original input

Extensions are host-side values with synchronous `setup(scope)`. `Terminal.create({ extensions })`
installs readonly recursive presets in encounter order before opening. `terminal.use(extension)`
returns a synchronous typed `{ api, dispose }` handle from the main entry and a Promise of that handle
from the worker entry. Worker setup and validation failures reject that Promise. Setup and handle
disposal remain synchronous host transactions.

```ts
import { Terminal, type Extension } from 'ghostty-webgpu'

const inputGate: Extension<{ setBlocked(value: boolean): void }> = {
  name: 'input-gate',
  setup: () => {
    let blocked = false
    return {
      api: {
        setBlocked: (value) => {
          blocked = value
        },
      },
      input: () => (blocked ? 'claim' : 'pass'),
    }
  },
}

const terminal = await Terminal.create()
const gate = terminal.use(inputGate)
gate.api.setBlocked(true)
```

Each attachment receives its own scope, lazy abort signal and owned cleanup stack. One value can
attach to several terminals; duplicate identity on the same terminal is rejected. Detaching permits
a fresh attachment. Setup and preset failures roll back acquired resources. Terminal disposal removes
attachments and owned cleanup in reverse order. Owned cleanup runs once; handle and terminal disposal
are idempotent.

`input` receives the original DOM key event, programmatic key input, paste/text data or committed
composition text before native normalization and encoding. The first `claim` stops dispatch and PTY
emission. Passing input uses the existing native encoder, including keyboard and bracketed-paste modes.
DOM claims and default prevention are synchronous. Native protocol replies remain observable through
`data` and bypass input claims. Contributions under `events` receive the public host event payloads;
only interested handlers are indexed and frame payloads are constructed when observed.

Public custom OSC observation requires numeric reservation metadata and a host subscription adapter.
This checkpoint rejects nonempty OSC contributions and rolls back their setup. Native Session OSC
observation is available separately. Named-command and contributed-link registries remain internal;
explicit `registerLinkProvider` continues to work. Native width and geometry methods keep their
synchronous-main and Promise-worker return conventions. Setup closures stay on the host.

## more

- [pty wiring and the native api](docs/integration.md)
- [font geometry and Canvas comparison](docs/font-geometry.md)
- [live demo](https://shaullavo.github.io/ghostty-webgpu/), built from [site/](site/) with `bun run site:dev`
- [optional native ghostty config](docs/config-resolver.md)

Terminal bindings and hosted focus setup use the [hotkeys input connection](docs/hotkeys.md).
`attachTerminalHotkeys` owns one synchronous main-host input lease and constructs no general
manager. Its claim stops forwarding; its pass reaches explicitly installed general input
contributions, then native once. The public extension APIs above retain their separate ownership.
