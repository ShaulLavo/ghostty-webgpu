# Browser integration

Install a built release tarball or link a checkout as [use ghostty-webgpu in your own app](use-in-your-app.md) shows. See [the API reference](api.md) for workers, frame ownership, geometry, and extensions. The [integration guarantee audit](integration-guarantees.md) covers disposal, shared resources, WASM assets, renderer replacement, and synchronous replies.

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

terminal.onData(({ bytes }) => {
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

## Connect a byte-first PTY

Run the PTY on your server. Each example takes a `send` function that sends binary output to an authenticated WebSocket. Forward incoming binary messages to `write`, validated grid dimensions to `resize`, and the socket close event to `close`. Check authentication and the WebSocket origin before opening a shell. See [Security](#security).

### Bun

Bun's built-in terminal option connects a subprocess to a PTY. Its data callback receives `Uint8Array` output:

```js
export function openPty(send) {
  const terminal = new Bun.Terminal({
    cols: 80,
    rows: 24,
    data(_terminal, bytes) {
      send(bytes)
    },
  })
  const child = Bun.spawn([process.env.SHELL ?? '/bin/sh'], { terminal })
  void child.exited.finally(() => terminal.close())
  return {
    write: (bytes) => terminal.write(bytes),
    resize: (cols, rows) => terminal.resize(cols, rows),
    close() {
      child.kill()
      terminal.close()
    },
  }
}
```

### Node

Install `node-pty` in your server project. Set `encoding: null` so output arrives as bytes, and write incoming bytes as a `Buffer`:

```js
import { spawn } from 'node-pty'

export function openPty(send) {
  const terminal = spawn(process.env.SHELL ?? '/bin/sh', [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    encoding: null,
  })
  terminal.onData(({ bytes }) => send(bytes))
  return {
    write: (bytes) => terminal.write(Buffer.from(bytes)),
    resize: (cols, rows) => terminal.resize(cols, rows),
    close: () => terminal.kill(),
  }
}
```

Keep each socket bound to its own PTY and bound queued output in a production server. The [local demo](../demo/src/pty-bridge.mjs) uses the maintained `@lydell/node-pty` fork and adds flow control and shutdown handling.

## ZWJ emoji and grapheme widths

libghostty-vt owns grapheme clustering and terminal cell widths. Mode 2027 is off by default.
In that mode, `👩‍💻` occupies four cells and `👨‍👩‍👧‍👦` occupies eight cells.
Applications enable grapheme clustering with `CSI ? 2027 h`, or `\x1b[?2027h` in a string.
With mode 2027 enabled, each sequence occupies two cells and the renderer shapes its complete
cell text through the browser's font fallback. `CSI ? 2027 l` restores the default width behavior.

WebGPU, WebGL2, and Canvas2D follow the same native cell ownership. Emoji appearance depends
on the available fallback fonts. GPU atlases preserve intrinsic RGB and alpha, including gray
emoji. RGBA glyphs use the resolved foreground and a color-keyed cache so mixed COLR
currentColor layers follow SGR, theme, selection, cursor and minimum-contrast colors.
Bitmap retention is bounded to 4 MiB and 4,096 entries, and atlas layers have their own
fixed capacity. Ordinary text and foreground-only COLR glyphs share a one-byte coverage
mask across foreground colors.

## Security

The terminal sends every keystroke to the socket you give it, so the PTY endpoint decides who gets a shell. Authenticate the endpoint and check the WebSocket `Origin` header on the server. The [local demo](../demo/src/authorization.ts) shows one way. It binds `127.0.0.1`, puts a random token in the page, and rejects upgrades with a wrong host, origin, or token.

A program in the terminal can ask to write the clipboard with OSC 52. The terminal denies that unless you pass a `clipboardWrite` policy to `Terminal.create()`. It sends no reply to OSC 52 reads. Report vulnerabilities as the [security policy](https://github.com/ShaulLavo/fregat/blob/main/SECURITY.md) describes.

## Verification

`bun run build` builds the browser distribution without native resolver assembly.
`bun run test:package` checks a clean packed install, including browser imports, types, bundling,
WASM, and displayed Canvas2D output. `bun run verify` runs the browser verification path.
