# Browser integration

Install with `npm install ghostty-webgpu`.

The terminal mount needs a real size.

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

PTY traffic stays as bytes through the native API.

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

The terminal fits its grid to the mount automatically. Call `terminal.dispose()` when removing
the terminal. Close the WebSocket when your application no longer needs the PTY connection.

## Verification

`bun run build` builds the browser distribution without native resolver assembly.
`bun run test:package` checks a clean packed install, including browser imports, types, bundling,
WASM, and displayed Canvas2D output. `bun run verify` runs the browser verification path.
