# Status and limits

ghostty-webgpu is pre-1.0 and experimental. The facts below are true at package version 0.3.24. Each row names where the claim comes from, so you can recheck it.

## Stability

- Breaking changes ship in patch releases. The [changelog](../CHANGELOG.md) marks them "Breaking".
- npm's latest release is 0.1.2 (published 2026-09-28). It predates the current API. Check with `npm view ghostty-webgpu version`.
- The docs and the site describe the source checkout. Run it from Fregat's workspace, as the [README quick start](../README.md#quick-start) shows.

## Entry points

| Import                           | Runs in           | Notes                                                               |
| -------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `ghostty-webgpu`                 | Browser           | `Terminal`, `TerminalSession`, `GhosttyTerminal`, `GhosttyRuntime`. |
| `ghostty-webgpu/worker`          | Browser           | The emulator and GPU renderer in a dedicated worker.                |
| `ghostty-webgpu/config-resolver` | Node and Bun only | Reads the user's Ghostty config. Keep it out of client bundles.     |

`GhosttyRuntime` and `GhosttyTerminal` use no DOM globals. The core tests run under plain Node (`bun run test:unit`). `package.json` sets `engines.node` to `>=20`.

## Browser support

| Environment       | Status           | Evidence                                                                                                                                                            |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium, desktop | Tested           | The `workspace-libraries` workflow runs the browser suite in Chromium. Benchmarks use Chrome 154 on macOS. The correctness run uses headless Chromium 153 on Linux. |
| Firefox, WebKit   | Not tested in CI | `vitest.browser.config.ts` accepts `GHOSTTY_BROWSER_ENGINE=firefox` or `webkit`. No Ghostty workflow sets it.                                                       |
| iPhone Safari     | Not tested in CI | A tap-dismisses-keyboard bug was fixed in 0.3.22. No automated test covers it.                                                                                      |

WebGPU needs a secure context and a hardware adapter. Without one, the terminal falls through to WebGL2, Canvas 2D, then the DOM. [Concepts](concepts.md#four-renderers-and-the-order-they-are-tried) shows the order.

## Feature status

| Area                               | State                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGPU, WebGL2, DOM renderers      | Implemented. Compared with xterm.js in [benchmarks](benchmarks.md) on one Mac.                                                                                             |
| Canvas 2D `canvas2d-fill-text`     | Implemented. This is the Canvas default.                                                                                                                                   |
| Canvas 2D `canvas2d-pixels`        | Experimental. Correctness tests exist. Visual calibration and performance qualification are pending.                                                                       |
| Worker entry                       | Partial. No Canvas modes, no link providers, no keyboard link discovery. Hotkeys are main-entry only.                                                                      |
| Accessibility                      | Opt-in text mirror and live region (`accessibility: {}`). No screen-reader audit yet.                                                                                      |
| Clipboard                          | OSC 52 writes are denied unless the host sets a `clipboardWrite` policy. OSC 52 reads get no reply.                                                                        |
| Search, image protocols, ligatures | Not built.                                                                                                                                                                 |
| VT conformance                     | 167 of 169 selected cases pass. Full conformance is not claimed. See [correctness](correctness.md).                                                                        |
| Config resolver                    | Source checkout holds only `native/config-resolver/bootstrap.json`. Native binaries exist only in assembled host distributions. See [config resolver](config-resolver.md). |

## Evidence limits

- Benchmarks come from one Apple M1 MacBook, two balanced pairs per row, with an uncalibrated observer. They carry no significance test. [benchmarks.md](benchmarks.md) lists what they do not show.
- The report makes no memory claim. A fair comparison needs a fresh whole-browser session.
- Correctness covers 132 selected esctest2 methods and 37 local cases. It is not the full suite.

## Platform notes for contributors

Rebuilding `ghostty-vt.wasm` needs Zig 0.16.0 or newer and the pinned upstream revision. See [development](development.md).
