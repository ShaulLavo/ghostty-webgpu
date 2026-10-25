# Use ghostty-webgpu in your own app

Install a built tarball from a [GitHub release](https://github.com/ShaulLavo/ghostty-webgpu/releases), then ship the three `.wasm` files with your app. The historical npm release uses an earlier API.

## Install a release

Copy the terminal tarball URL from the release you selected, and pin that exact URL in your app:

```sh
bun add ghostty-webgpu@<release-asset-url>
```

The URL ends in `/ghostty-webgpu.tgz`. npm can install the same tarball with `npm install <release-asset-url>`. Each release identifies its source commit. The tarball includes built JavaScript, declarations, and the checked-in wasm files, so consumers need no compiler or lifecycle scripts.

The optional `ghostty-webgpu-line-editor.tgz` and `ghostty-webgpu-shaders.tgz` assets install the same way. Install the terminal alongside either addon to satisfy its peer dependency.

## Build and link a checkout

For development, install Bun 1.4.4 and Node 20 or newer:

```sh
git clone https://github.com/ShaulLavo/ghostty-webgpu.git
cd ghostty-webgpu
bun install --frozen-lockfile
bun run build
```

`build` compiles `src/` to `dist/` and bundles the worker. The pinned `@fregat/hotkeys` dependency arrives already built. The three wasm files are checked in. See [development](development.md#rebuild-the-wasm) to rebuild them.

From your app, link the checkout with an absolute path:

```sh
bun add ghostty-webgpu@link:/absolute/path/to/ghostty-webgpu
```

Rebuild after a source edit. To test the release layout locally, run `bun run verify` in the checkout and install its `.artifacts/ghostty-webgpu.tgz` in your app. A Git source archive contains source files, so use a built release tarball for a dependency that can run immediately after install.

## Import it

```ts
import { Terminal } from 'ghostty-webgpu'

const terminal = await Terminal.create()
await terminal.open(document.getElementById('terminal')!)
terminal.write('hello from ghostty\r\n')
```

The mount element needs a real height. See [browser integration](integration.md).

## Ship the wasm files

By default the package finds its `.wasm` files with `new URL('../../ghostty-vt.wasm', import.meta.url)` in `dist/core/assets.js` (`src/core/assets.ts`). Your bundler has to copy them, and your server has to send them as `application/wasm`.

- Vite: nothing to do. `vite build` emitted `ghostty-vt-<hash>.wasm` and `bridge-<hash>.wasm` under `assets/`, and a headless Chromium run loaded both with HTTP 200.
- `bun build` HTML: the bundle keeps the `new URL(...)` and copies no `.wasm`. The page failed with `expected magic word 00 61 73 6d` until the files sat beside the bundle.

`bun build` needs the copy step. For an `index.html` built into `dist/`, this made the same page work:

```sh
cp node_modules/ghostty-webgpu/{ghostty-vt,bridge,canvas-compose}.wasm dist/
```

That layout works only when the bundled JavaScript sits at the output root. For any other layout, give the terminal explicit URLs.

### Pass explicit URLs

The package exports the three files, so a bundler can resolve them for you. With Vite's `?url` suffix:

```ts
import { Terminal } from 'ghostty-webgpu'
import wasm from 'ghostty-webgpu/ghostty-vt.wasm?url'
import bridge from 'ghostty-webgpu/bridge.wasm?url'

const terminal = await Terminal.create({
  runtime: {
    kind: 'owned',
    options: { wasm: new URL(wasm, location.href), bridge: new URL(bridge, location.href) },
  },
})
```

The [local demo](../demo/src/client.ts) passes `runtime` the same way with fixed paths. A `WasmSource` is a `URL`, a string, an `ArrayBuffer`, a typed array, or a compiled `WebAssembly.Module`.

The [worker entry](https://ghostty.shaulavo.dev/docs/guides/workers/) takes `assets: { wasm, bridge }` and `workerUrl` as strings instead. It also needs `fonts`, because the worker cannot read the page's fonts. This worker run passed with Vite:

```ts
import { Terminal } from 'ghostty-webgpu/worker'
import wasm from 'ghostty-webgpu/ghostty-vt.wasm?url'
import bridge from 'ghostty-webgpu/bridge.wasm?url'

const terminal = await Terminal.create({
  fonts: [{ family: 'Terminal Mono', source: { url: new URL('/mono.woff2', location.href).href } }],
  assets: { wasm: new URL(wasm, location.href).href, bridge: new URL(bridge, location.href).href },
})
```

Vite bundled the default worker file on its own, so `workerUrl` was not needed.

`canvas-compose.wasm` loads only in `canvas2d-pixels` mode, which is experimental. Vite did not emit it for the runs above.

If you set a Content Security Policy, allow WebAssembly compilation with `'wasm-unsafe-eval'` in `script-src`. The demo's policy shows the full set (`demo/src/authorization.ts`).

## Package exports

- `ghostty-webgpu` resolves to `dist/index.js`. The main-thread `Terminal`.
- `ghostty-webgpu/worker` resolves to `dist/worker/index.js`. The worker `Terminal`.
- `ghostty-webgpu/config-resolver` resolves to `dist/config-resolver/index.js`. Reading a Ghostty config. Bun and Node only. See [config resolver](config-resolver.md).
- `ghostty-webgpu/ghostty-vt.wasm` resolves to `ghostty-vt.wasm`. The terminal core.
- `ghostty-webgpu/bridge.wasm` resolves to `bridge.wasm`. The frame builder for WebGPU and WebGL2.
- `ghostty-webgpu/canvas-compose.wasm` resolves to `canvas-compose.wasm`. The Canvas 2D pixel mode.

The list comes from `exports` in `package.json`. Any other subpath fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## If it breaks

- `Unable to fetch wasm artifact` or `expected magic word`: the `.wasm` URL returned HTML or 404. See [troubleshooting](troubleshooting.md#the-browser-fails-to-load-a-wasm-file).
- The import does not resolve and `ghostty-webgpu/dist/` is missing: run the build step again.
