# ghostty-webgpu

an unofficial ghostty for the web inspired by [ghostty-web](https://github.com/coder/ghostty-web) and powered by libghostty-vt

the goal is to bring as much of ghostty to the browser as possible while staying true to how it behaves

rendering is damage-aware and webgpu only with no webgl fallback

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
