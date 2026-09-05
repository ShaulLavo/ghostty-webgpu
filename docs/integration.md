# Browser integration

Install with `npm install ghostty-webgpu`.

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

Call `terminal.dispose()` when removing either terminal. Close the WebSocket when your application
no longer needs the PTY connection.

## Verification

`bun run build` builds the browser distribution without native resolver assembly.
`bun run test:package` checks a clean packed install, including browser imports, types, bundling,
WASM and displayed Canvas2D output. `bun run verify` runs the browser verification path.

The [replacement contract](replacement/README.md) records migration gaps and comparison evidence.
`bun run test:replacement` runs both packages and fails on unresolved workflows.
