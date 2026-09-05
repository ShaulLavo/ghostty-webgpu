# ghostty-webgpu

an unofficial ghostty for the web inspired by [ghostty-web](https://github.com/coder/ghostty-web) and powered by libghostty-vt

the goal is a standalone, embeddable ghostty terminal that people choose over ghostty-web for its behavior, rendering, resource use, and ease of integration

rendering is damage-aware and tries webgpu, webgl2, then canvas2d, with event-driven drawing on every backend

mounted terminals switch to canvas2d if their webgl context is lost, preserving the session and input

there is also an xterm-shaped api for existing integrations, with [documented compatibility gaps](docs/xterm-parity.md)

the project is a preview. the [replacement-readiness roadmap](plans/016-ghostty-web-replacement-readiness.md) covers migration from ghostty-web, remaining useful APIs, independent package readiness, and direct comparisons. complete xterm certification is not a release requirement

## install

```sh
npm install ghostty-webgpu
```

the terminal mount needs a real size

```html
<div id="terminal"></div>
```

```css
#terminal {
  height: 32rem;
  width: 100%;
}
```

## native api

this one keeps pty traffic as bytes all the way through

```ts
import { Terminal } from 'ghostty-webgpu'

const host = document.querySelector<HTMLElement>('#terminal')
if (!host) throw new Error('missing terminal mount')

const terminal = await Terminal.create()
await terminal.open(host)

const socket = new WebSocket('wss://example.com/pty')
socket.binaryType = 'arraybuffer'

terminal.onData((bytes) => {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(bytes)
})

socket.addEventListener('message', ({ data }) => {
  if (!(data instanceof ArrayBuffer)) return
  terminal.write(new Uint8Array(data))
})

terminal.focus()
```

## xterm api

this one keeps the familiar synchronous xterm shape

```ts
import { Terminal } from 'ghostty-webgpu/xterm'
import 'ghostty-webgpu/xterm.css'

const host = document.querySelector<HTMLElement>('#terminal')
if (!host) throw new Error('missing terminal mount')

const terminal = new Terminal({
  cols: 100,
  cursorBlink: true,
  rows: 30,
})
terminal.open(host)

const socket = new WebSocket('wss://example.com/pty')
socket.binaryType = 'arraybuffer'

terminal.onData((data) => {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(data)
})

socket.addEventListener('message', ({ data }) => {
  if (!(data instanceof ArrayBuffer)) return
  terminal.write(new Uint8Array(data))
})
```

the native api auto fits to its mount while the xterm api keeps its configured grid until you call `resize`

## ghostty config appearance

Server-side Node and Bun applications can resolve the current user's Ghostty appearance through
the host-only entry point:

```ts
import { resolveGhosttyConfigAppearance } from 'ghostty-webgpu/config-resolver'

const result = await resolveGhosttyConfigAppearance()
if (result.status === 'ready') {
  console.log(result.appearance)
}
```

Optional assembled host distributions target the following matrix. Browser builds do not
require these binaries. A browser package verification does not qualify their availability:

| OS    | Architecture | Compatibility                  |
| ----- | ------------ | ------------------------------ |
| macOS | `arm64`      | macOS 13.0 or newer            |
| macOS | `x64`        | macOS 13.0 or newer            |
| Linux | `arm64`      | fully static; no libc required |
| Linux | `x64`        | fully static; no libc required |

Using an assembled host distribution does not require an installed Ghostty or Zig toolchain.
A `ready` result contains schema and pinned
upstream revisions, a bounded diagnostic count, one canonical appearance revision, and light/dark
profiles with bounded colors, palette entries, surface values, and fidelity markers. Each profile
reports `exact` when every native value maps directly; `best-effort` is accompanied by ordered
degradation markers for values such as cell-relative colors, Display-P3 conversion, blur, or macOS
glass.

An `unavailable` result contains only one fixed reason: `config-not-found`, `invalid-output`,
`output-limit`, `resolver-failed`, `timeout`, or `unsupported-platform`. Failures do not expose
config text, paths, theme names, environment values, diagnostics, commands, stderr, or native
output.

This subpath is intentionally unavailable to browsers. Server bundlers must externalize
`ghostty-webgpu/config-resolver`; do not include it in a client bundle. The browser-safe package root
does not import the resolver or its native assets.

## Browser and host verification

`bun run build` builds the browser distribution without native config-resolver assembly.
`bun run test:package` installs the packed artifact in a clean external consumer and checks browser
imports, types, bundling, WASM and displayed Canvas2D output. `bun run verify` runs the browser
verification path. The resolver remains an optional host integration.

Use `bun run build:host`, `bun run verify:host` and `bun run test:package:host` when qualifying an
assembled host distribution. Those commands retain native artifact and provenance checks.
Missing host binaries are not a successful host qualification.

The [replacement contract](docs/replacement/README.md) pins the comparison release and describes
migration gaps. `bun run test:replacement` records both packages' results and fails on unresolved
workflows. The package remains a preview.
