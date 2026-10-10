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
  <a href="https://shaulavo.dev/ghostty-webgpu/">Website and demo</a> ·
  <a href="https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md">API</a> ·
  <a href="https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/integration.md">Integration guide</a> ·
  <a href="https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/benchmarks.md">Benchmarks</a>
</p>

[![ghostty-webgpu rendering the ghost demo](https://raw.githubusercontent.com/ShaulLavo/fregat/main/ghostty-webgpu/docs/images/terminal.webp)](https://shaulavo.dev/ghostty-webgpu/)

An unofficial browser terminal powered by Ghostty's unpatched `libghostty-vt`, compiled to WebAssembly.
It has its own API and WebGPU, WebGL2, Canvas 2D, and DOM renderers.

## Measured wins and losses

[Reviewed benchmarks](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/benchmarks.md) compare like-for-like renderers.
These results come from an Apple M1 MacBook on AC power, headed Chrome 154.0.8037.93, acquired 2026-10-09 and reviewed 2026-10-10.
They compare ghostty-webgpu 0.3.21 with xterm.js 6.0.0 and WebGL addon 0.19.0.
The workload uses 17 visible terminals, 40 by 12 cells, DPR 2, and 900 measured ticks at 60 Hz after 120 warm-up ticks. Each row is the median of two balanced pairs.

Each ratio is ghostty divided by xterm.js. Below 1 means ghostty uses less estimated CPU energy or fewer instructions.

| WebGL vs xterm.js WebGL   | CPU energy ratio | Instruction ratio |
| ------------------------- | ---------------: | ----------------: |
| Heavy log output          |            0.612 |             0.613 |
| Heavy Unicode output      |            0.611 |             0.615 |
| One Unicode line per tick |            0.986 |             1.002 |
| One ASCII line per tick   |            0.955 |             0.985 |
| Typing-like edits         |            0.911 |             0.954 |

Heavy output uses about 39% less energy and fewer instructions. Scrolling and typing-like edits are lower by smaller margins. One Unicode line per tick is even: energy is 1.4% lower and instructions are 0.2% higher in both pairs, which the review records as an instruction loss.
These whole-browser counters measure CPU work and estimated CPU energy. The review marks every row publishable with limits. Two pairs per row, retained-history limits and observer qualifications matter.
Read the [method and recompute steps](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/benchmarks/mac-m1-2026-10-10/README.md) before applying the results to your workload.

### Correctness

The [2026-10-08 correctness run](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/correctness.md) checks a fixed selection of 132 esctest2 methods and 37 local cases.
On an Intel Core i7-14700K running Arch Linux with headless Chromium 153, ghostty-webgpu 0.3.20 passed 167 and failed 2.
xterm.js 6.0.0 passed 126 and failed 43. ghostty-web 0.4.0 passed 161 and failed 8.
The two ghostty-webgpu failures reproduce in the pinned upstream core. They remain failures.
Full VT conformance and general native Ghostty parity remain open. The report includes [versions and reproduction commands](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/correctness.md#reproduce).

## What it gives you

- **Ghostty's parser and state.** A pinned upstream core handles terminal behavior. See the [architecture](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md).
- **Four renderer choices.** Damage tracking redraws changed cells through WebGPU, WebGL2, Canvas 2D, or DOM. See the [renderer options](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md).
- **Byte-based shell connections.** Connect a WebSocket PTY, fit the terminal to its host, and forward input bytes. Read the [integration guide](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/integration.md).
- **Terminal interaction.** Selection, scrollback, OSC 8 links, Kitty keyboard input, and policy-gated clipboard access have [documented APIs](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/docs/api.md).
- **Visible text at first load.** The site puts the first terminal frame into its HTML. See the [first-frame design](https://github.com/ShaulLavo/fregat/blob/main/plans/285-ghostty-site-first-frame-and-real-shell.md).

## Quick start

[Open the live demo](https://shaulavo.dev/ghostty-webgpu/) to try the terminal and its Shell tab.
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
