# Browser integration

Install with `npm install ghostty-webgpu`.

See [the API reference](api.md) for workers, frame ownership, geometry, and extensions.

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

## Verification

`bun run build` builds the browser distribution without native resolver assembly.
`bun run test:package` checks a clean packed install, including browser imports, types, bundling,
WASM, and displayed Canvas2D output. `bun run verify` runs the browser verification path.
