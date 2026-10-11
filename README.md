<p align="center">
  <img src="https://raw.githubusercontent.com/ShaulLavo/fregat/main/ghostty-webgpu/site/public/favicon.svg" width="96" alt="ghostty-webgpu ghost mark" />
</p>
<h1 align="center">ghostty-webgpu</h1>
<p align="center">Ghostty's terminal, in the browser.</p>
<p align="center">
  <a href="https://github.com/ShaulLavo/fregat/actions/workflows/workspace-libraries.yml"><img src="https://github.com/ShaulLavo/fregat/actions/workflows/workspace-libraries.yml/badge.svg" alt="Workspace library checks" /></a>
  <a href="https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  <a href="https://github.com/ShaulLavo/fregat/tree/main/ghostty-webgpu"><img src="https://img.shields.io/badge/install-source%20%2F%20workspace-blue" alt="Install from source or workspace" /></a>
</p>
<p align="center">
  <a href="https://ghostty.shaulavo.dev/">Website and demo</a> ·
  <a href="https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md">API</a> ·
  <a href="https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/integration.md">Integration guide</a> ·
  <a href="https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/benchmarks.md">Benchmarks</a>
</p>

[![ghostty-webgpu rendering the ghost demo](https://raw.githubusercontent.com/ShaulLavo/fregat/main/ghostty-webgpu/docs/images/terminal.webp)](https://ghostty.shaulavo.dev/)

An unofficial browser terminal powered by Ghostty's unpatched `libghostty-vt`, compiled to WebAssembly.
It has its own API and WebGPU, WebGL2, Canvas 2D, and DOM renderers.

## Performance

WebGL compared with xterm.js WebGL. Each ratio is ghostty-webgpu divided by xterm.js; below 1 means less CPU work.

| Workload                  | CPU energy ratio | Instruction ratio |
| ------------------------- | ---------------: | ----------------: |
| Heavy log output          |            0.612 |             0.613 |
| Heavy Unicode output      |            0.611 |             0.615 |
| One Unicode line per tick |            0.986 |             1.002 |
| One ASCII line per tick   |            0.955 |             0.985 |
| Typing-like edits         |            0.911 |             0.954 |

Heavy output uses about 39% less CPU energy and fewer instructions. Scrolling and typing-like edits improve by smaller margins.
One Unicode line per tick is roughly even, with 1.4% less energy and 0.2% more instructions in both pairs.

<details>
<summary>Benchmark setup and limits</summary>

| Detail      | Setup                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine     | Apple M1 MacBook on AC power                                                                                                                                                           |
| Browser     | Headed Chrome 154.0.8037.93                                                                                                                                                            |
| Versions    | ghostty-webgpu 0.3.21, xterm.js 6.0.0, WebGL addon 0.19.0                                                                                                                              |
| Workload    | 17 visible terminals, 40 × 12 cells, DPR 2                                                                                                                                             |
| Sampling    | 900 measured ticks at 60 Hz after 120 warm-up ticks; each row is the median of two balanced pairs                                                                                      |
| Dates       | Acquired 2026-10-09, reviewed 2026-10-10                                                                                                                                               |
| Measurement | Whole-browser instruction counts and estimated CPU energy                                                                                                                              |
| Limits      | Two pairs per row; retained-history limits and observer qualifications apply. The review marks every row publishable with limits and records the Unicode instruction result as a loss. |

[Reviewed benchmarks](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/benchmarks.md) compare like-for-like renderers.
Read the [method and recompute steps](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/benchmarks/mac-m1-2026-10-10/README.md) before applying the results to your workload.

</details>

### Correctness

The [2026-10-08 run](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/correctness.md) checks 132 selected esctest2 methods and 37 local cases.

| Terminal              | Passed | Failed |
| --------------------- | -----: | -----: |
| ghostty-webgpu 0.3.20 |    167 |      2 |
| xterm.js 6.0.0        |    126 |     43 |
| ghostty-web 0.4.0     |    161 |      8 |

Tested on an Intel Core i7-14700K running Arch Linux with headless Chromium 153.
Both ghostty-webgpu failures reproduce in the pinned upstream core. Full VT conformance and general native Ghostty parity remain open.
See [versions and reproduction commands](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/correctness.md#reproduce).

## What it gives you

- **Ghostty's parser and state.** A pinned upstream core handles terminal behavior. See the [architecture](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md).
- **Four renderer choices.** Damage tracking redraws changed cells through WebGPU, WebGL2, Canvas 2D, or DOM. See the [renderer options](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md).
- **Byte-based shell connections.** Connect a WebSocket PTY, fit the terminal to its host, and forward input bytes. Read the [integration guide](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/integration.md).
- **Terminal interaction.** Selection, scrollback, OSC 8 links, Kitty keyboard input, and policy-gated clipboard access have [documented APIs](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md).
- **Visible text at first load.** The site puts the first terminal frame into its HTML. See the [first-frame design](https://github.com/ShaulLavo/fregat/blob/main/plans/285-ghostty-site-first-frame-and-real-shell.md).

## Quick start

[Open the live demo](https://ghostty.shaulavo.dev/) to try the terminal and its Shell tab.
The npm release is still 0.1.2. Current publishing is deferred. Use Fregat's source workspace for the API below:

```sh
git clone https://github.com/ShaulLavo/fregat.git
cd fregat
bun install --frozen-lockfile
bun run build:workspaces
```

Give the host element a height and width, then mount a terminal:

```ts
import { Terminal } from 'ghostty-webgpu'

const host = document.getElementById('terminal')!
const terminal = await Terminal.create()
await terminal.open(host)
terminal.write('hello from ghostty\r\n')
terminal.focus()
```

Call `terminal.dispose()` when you remove it.
For a real shell, follow the [WebSocket PTY example](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/integration.md).
For xterm.js integrations, start with the [API reference](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md) and map input, output, fitting, and cleanup explicitly.

## Planned work

| Work                                                  | Status      | Plan                                                                                                                                                                  |
| ----------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged worker mode and renderer parity              | In progress | [Worker mode](https://github.com/ShaulLavo/fregat/blob/main/plans/287-ghostty-worker-mode.md)                                                                         |
| Public extensions, including search and a line editor | In progress | [Extensions](https://github.com/ShaulLavo/fregat/blob/main/plans/286-ghostty-extensions.md)                                                                           |
| Fresh benchmark session across renderer pairs         | In progress | [Product proof](https://github.com/ShaulLavo/fregat/blob/main/plans/336-packages-as-products.md#track-p-proof-starts-now-benchmarks-run-through-the-heavy-job-runner) |

The [Fregat roadmap](https://github.com/ShaulLavo/fregat/blob/main/PLAN.md) owns scheduling.

## Credits and contributing

Thanks to [Ghostty](https://ghostty.org/) for the terminal core and [ghostty-web](https://github.com/coder/ghostty-web) for the inspiration.
Development happens in [Fregat](https://github.com/ShaulLavo/fregat/tree/main/ghostty-webgpu).
This repository is a read-only mirror. Submit issues and pull requests to Fregat.
Read the [contribution guide and AI policy](https://github.com/ShaulLavo/fregat/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/LICENSE).
The [third-party notices](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/THIRD_PARTY_NOTICES.md) cover the bundled Ghostty code.
