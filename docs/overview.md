<p align="center">
  <img src="https://raw.githubusercontent.com/ShaulLavo/ghostty-webgpu/main/site/public/favicon.svg" width="96" alt="ghostty-webgpu ghost mark" />
</p>
<h1 align="center">ghostty-webgpu</h1>
<p align="center">Ghostty's terminal, in the browser.</p>
<p align="center">
  <a href="https://github.com/ShaulLavo/ghostty-webgpu/actions/workflows/ci.yml"><img src="https://github.com/ShaulLavo/ghostty-webgpu/actions/workflows/ci.yml/badge.svg" alt="Workspace library checks" /></a>
  <a href="https://github.com/ShaulLavo/ghostty-webgpu/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  <a href="https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/status.md"><img src="https://img.shields.io/badge/status-pre--1.0-orange" alt="Pre-1.0 status" /></a>
</p>
<p align="center">
  <a href="https://ghostty.shaulavo.dev/">Website and demo</a> ·
  <a href="https://ghostty.shaulavo.dev/docs/">Docs</a> ·
  <a href="https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks.md">Benchmarks</a>
</p>

[![ghostty-webgpu rendering the ghost demo in a window with Ghost, Matrix and Shell tabs](https://raw.githubusercontent.com/ShaulLavo/ghostty-webgpu/main/docs/images/terminal.webp)](https://ghostty.shaulavo.dev/)

An unofficial browser terminal. It runs Ghostty's unpatched `libghostty-vt`, compiled to WebAssembly, and draws with WebGPU, WebGL2, Canvas 2D, or the DOM. You get Ghostty's parser and screen state behind its own TypeScript API.

```ts
import { Terminal } from 'ghostty-webgpu'

const terminal = await Terminal.create()
await terminal.open(document.getElementById('terminal')!)
terminal.write('hello from ghostty\r\n')
```

- **One terminal state.** Ghostty owns parsing, cell widths, and history. Selection, text reads, and every renderer read that same state.
- **Four renderers with fallback.** The terminal picks WebGPU or WebGL2, then Canvas 2D, then the DOM. Damage tracking redraws only what changed.
- **Bytes in, bytes out.** `write()` accepts bytes and `onData()` emits bytes, so a WebSocket PTY needs no translation layer. `onDataEvent()` adds the input/reply origin when an application needs it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ShaulLavo/ghostty-webgpu/main/docs/assets/architecture.dark.svg">
  <img alt="Bytes from a shell or app pass through the Terminal host into libghostty-vt. Its state feeds the Canvas 2D and DOM renderers directly, and feeds a Zig frame builder that drives the WebGPU and WebGL2 renderers." src="https://raw.githubusercontent.com/ShaulLavo/ghostty-webgpu/main/docs/assets/architecture.light.svg">
</picture>

_Bytes flow through one wasm core. Canvas 2D and the DOM read rows from it. WebGPU and WebGL2 get changed byte ranges from the frame builder._

## Quick start

See [installation](use-in-your-app.md) for a packed release or local checkout, and [development](development.md) for the build and demo commands.

## What you can do

- Connect a real shell over a WebSocket: [Connect a PTY](https://ghostty.shaulavo.dev/docs/guides/pty/).
- Move off xterm.js or ghostty-web: [from xterm.js](https://ghostty.shaulavo.dev/docs/start/xterm/) or [from ghostty-web](https://ghostty.shaulavo.dev/docs/start/ghostty-web/).
- Pick or force a renderer: [Renderers and fallbacks](https://ghostty.shaulavo.dev/docs/guides/renderers/).
- Run the emulator and GPU in a worker: [Worker entry](https://ghostty.shaulavo.dev/docs/guides/workers/).
- Load fonts, set themes, bind hotkeys: [fonts](https://ghostty.shaulavo.dev/docs/guides/fonts/), [themes](https://ghostty.shaulavo.dev/docs/guides/themes/), [hotkeys](https://ghostty.shaulavo.dev/docs/guides/hotkeys/).
- Read history, save and restore a viewport: [Scrollback](https://ghostty.shaulavo.dev/docs/guides/scrollback/).
- Look up an option or a type: [Options](https://ghostty.shaulavo.dev/docs/reference/options/) and the [generated API](https://ghostty.shaulavo.dev/docs/reference/api/).
- Fix a symptom: [Troubleshooting](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/troubleshooting.md).

## Performance

WebGL compared with xterm.js WebGL. Each ratio is ghostty-webgpu divided by xterm.js; below 1 means less CPU work.

| Workload                  | CPU energy ratio | Instruction ratio |
| ------------------------- | ---------------: | ----------------: |
| Heavy log output          |            0.612 |             0.613 |
| Heavy Unicode output      |            0.611 |             0.615 |
| One Unicode line per tick |            0.986 |             1.002 |
| One ASCII line per tick   |            0.955 |             0.985 |
| Typing-like edits         |            0.911 |             0.954 |

Heavy output uses about 39% less CPU energy and fewer instructions. One ASCII line per tick (the `line-scroll` workload, which scrolls the screen one row per tick) and typing-like edits improve by smaller margins.
One Unicode line per tick is roughly even, with 1.4% less energy and 0.2% more instructions in both pairs.

<details>
<summary>Benchmark setup and limits</summary>

- **Machine:** Apple M1 MacBook on AC power.
- **Browser:** headed Chrome 154.0.8037.93.
- **Versions:** ghostty-webgpu 0.3.21, xterm.js 6.0.0, WebGL addon 0.19.0.
- **Workload:** 17 visible terminals, 40 × 12 cells, DPR 2.
- **Sampling:** 900 measured ticks at 60 Hz after 120 warm-up ticks. Each row is the median of two balanced pairs.
- **Date:** measured 2026-10-09.
- **Measurement:** whole-browser instruction counts and estimated CPU energy.
- **Limits:** two pairs per row. Retained-history limits and observer qualifications apply. For one Unicode line per tick, instructions are higher (1.002).

Recompute the table without a browser, from `ghostty-webgpu/`: `node docs/benchmarks/mac-m1-2026-10-10/verify.mjs`.
The [full benchmarks](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks.md) cover DOM too, and the [method and recompute steps](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks/mac-m1-2026-10-10/README.md) list what the numbers do not show. Read them before applying the results to your workload.

</details>

### Correctness

The [2026-10-08 run](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/correctness.md) checks 132 selected esctest2 methods and 37 local cases.

- ghostty-webgpu 0.3.20: 167 passed, 2 failed.
- xterm.js 6.0.0: 126 passed, 43 failed.
- ghostty-web 0.4.0: 161 passed, 8 failed.

Tested on an Intel Core i7-14700K running Arch Linux with headless Chromium 153.
Both ghostty-webgpu failures reproduce in the pinned upstream core. Full VT conformance and general native Ghostty parity remain open.
See [versions and reproduction commands](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/correctness.md#reproduce).

## How it works

`libghostty-vt` runs as WebAssembly and owns the screen, cursor, modes, and scrollback. The `Terminal` class adds the DOM parts: fitting, focus, pointer and keyboard input, selection, and links. For WebGPU and WebGL2, a Zig frame builder in `bridge.wasm` keeps cell and glyph records and reports only the byte ranges that changed. Canvas 2D and the DOM read rows straight from the core. Read [concepts](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/concepts.md) for the full path and the renderer fallback order.

## Docs

[Tutorials and guides](https://ghostty.shaulavo.dev/docs/) · [Concepts](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/concepts.md) · [Reference and internals](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/README.md) · [Decision records](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/adr/001-unpatched-pinned-ghostty-core.md) · [Changelog](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/CHANGELOG.md)

## Status

Pre-1.0 and experimental. Breaking changes ship in patch releases, and the API is not frozen.

- **Not on npm at this API.** npm's latest is 0.1.2. This README describes version 0.3.24 from source.
- **Tested in Chromium.** CI runs the library's browser tests in Chromium only. Firefox and WebKit are not part of CI. The benchmarks come from one Mac.
- **Open gaps.** Search, image protocols, and ligatures are not built. Accessibility has a text mirror, and a screen-reader audit is still open. The worker entry lacks Canvas modes and link providers. Canvas pixel mode is experimental.

Platform notes and the full list are in [status and limits](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/status.md).

## Credits, contributing, license

Thanks to [Ghostty](https://ghostty.org/) for the terminal core and [ghostty-web](https://github.com/coder/ghostty-web) for the inspiration.
Send changes to [ghostty-webgpu](https://github.com/ShaulLavo/ghostty-webgpu) and follow the [development notes](development.md).

[MIT](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/LICENSE). The [third-party notices](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/THIRD_PARTY_NOTICES.md) cover the bundled Ghostty code.
