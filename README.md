# ghostty-webgpu

`ghostty-webgpu` is a standalone web package built on upstream libghostty-vt. It provides the
unpatched wasm runtime, callback ABI bridge, terminal ownership, damage-aware render state, and a
no-standing-loop WebGPU text renderer. DOM input and host integration remain separate layers.

The package is dist-first: package exports point at `dist`, while the two checked-in wasm
artifacts sit at the package root so consumers never need Zig.

## Development

```bash
bun install
bun run verify
```

The verification gate runs browser-independent tests plus real Chromium WebGPU readback tests.
To run them separately:

```bash
bun run test:unit
bun run test:browser
```

The headed hardware benchmark measures focused idle, unfocused idle, burst output, and sustained
scroll at 200×50 and DPR 2:

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

The build uses Ghostty revision `f64f4aca2c29b554d111b36c3d946a9bddd159ff` and runs its
unmodified
`zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall` target.
This pin requires Zig 0.16.0 or newer; pass `--zig /path/to/zig` to select a specific binary.

## Renderer API

```ts
import { GhosttyRuntime, WebGpuTerminalRenderer } from 'ghostty-webgpu'

const runtime = await GhosttyRuntime.create()
const terminal = runtime.createTerminal({
  columns: 80,
  rows: 24,
  effects: {
    writePty: (bytes) => pty.write(bytes),
  },
})
const renderState = runtime.createRenderState(terminal)
const canvas = document.querySelector<HTMLCanvasElement>('#terminal')!
const renderer = await WebGpuTerminalRenderer.create({
  canvas,
  cellHeight: 18,
  cellWidth: 9,
  columns: 80,
  rows: 24,
  renderState,
})

terminal.write('\u001b[32mready\u001b[0m')
renderer.notifyWrite()

renderer.setFocused(true)
renderer.setCursorBlinkEnabled(true)

renderer.dispose()
renderState.dispose()
terminal.dispose()
runtime.dispose()
```

The renderer consumes and acknowledges libghostty-vt damage only after GPU submission. Repeated
wake-ups coalesce into one pending frame; clean or unfocused idle has no standing animation loop.
Unset cell backgrounds remain transparent, while explicit terminal backgrounds are opaque. The
canvas is configured for premultiplied-alpha compositing.

`GhosttyRuntime.create()` resolves the committed artifacts relative to the package. Explicit
`wasm` and `bridge` sources can be supplied as URLs, `WebAssembly.Module` values, or bytes.

PNG decoding is a module-global libghostty-vt setting. Supply `decodePng` while creating the
runtime, before any terminal is created. A decoder is synchronous and must return RGBA8 pixels;
one runtime shares it across every terminal in that wasm instance.
