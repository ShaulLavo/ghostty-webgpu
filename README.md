# ghostty-webgpu

`ghostty-webgpu` is a standalone web package built on upstream libghostty-vt. Phase 1 provides
the unpatched wasm runtime, its callback ABI bridge, terminal ownership, and damage-aware render
state bindings. The WebGPU renderer and browser host layers land in later phases.

The package is dist-first: package exports point at `dist`, while the two checked-in wasm
artifacts sit at the package root so consumers never need Zig.

## Development

```bash
bun install
bun run verify
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

## Core API

```ts
import { GhosttyRuntime } from 'ghostty-webgpu'

const runtime = await GhosttyRuntime.create()
const terminal = runtime.createTerminal({
  columns: 80,
  rows: 24,
  effects: {
    writePty: (bytes) => pty.write(bytes),
  },
})
const renderState = runtime.createRenderState(terminal)

terminal.write('\u001b[32mready\u001b[0m')
renderState.update()
const dirtyRows = renderState.readRows({ dirtyOnly: true })
renderState.acknowledge()
```

`GhosttyRuntime.create()` resolves the committed artifacts relative to the package. Explicit
`wasm` and `bridge` sources can be supplied as URLs, `WebAssembly.Module` values, or bytes.

PNG decoding is a module-global libghostty-vt setting. Supply `decodePng` while creating the
runtime, before any terminal is created. A decoder is synchronous and must return RGBA8 pixels;
one runtime shares it across every terminal in that wasm instance.
