# ghostty-webgpu

an unofficial ghostty for the web inspired by [ghostty-web](https://github.com/coder/ghostty-web) and powered by libghostty-vt

the goal is to bring as much of ghostty to the browser as possible while staying true to how it behaves

rendering is damage-aware and tries webgpu, webgl2, then canvas2d, with event-driven drawing on every backend

mounted terminals switch to canvas2d if their webgl context is lost, preserving the session and input

there is also an xterm-compatible api for existing integrations with parity still in progress

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

The packaged host matrix is:

| OS    | Architecture | Compatibility                  |
| ----- | ------------ | ------------------------------ |
| macOS | `arm64`      | macOS 13.0 or newer            |
| macOS | `x64`        | macOS 13.0 or newer            |
| Linux | `arm64`      | fully static; no libc required |
| Linux | `x64`        | fully static; no libc required |

An installed Ghostty or Zig toolchain is not required. A `ready` result contains schema and pinned
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
