# ghostty-webgpu docs map

Tutorials and task guides are on [ghostty.shaulavo.dev/docs](https://ghostty.shaulavo.dev/docs/). Their sources are in `site/src/content/docs/`. This folder holds concepts, reference, and contributor pages.

## Pages

| Page                                                 | Kind        | Use it to                                                               |
| ---------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| [concepts.md](concepts.md)                           | Explanation | See how bytes become pixels and how a renderer is chosen.               |
| [status.md](status.md)                               | Reference   | Check stability, browser support, and known gaps.                       |
| [troubleshooting.md](troubleshooting.md)             | How-to      | Fix a blank terminal, a missing `.wasm`, or a denied clipboard.         |
| [integration.md](integration.md)                     | How-to      | Wire a terminal to a WebSocket PTY and learn the emoji width rule.      |
| [api.md](api.md)                                     | Reference   | Look up exact behavior of frames, scrollback, geometry, and extensions. |
| [hotkeys.md](hotkeys.md)                             | Reference   | Look up `attachTerminalHotkeys`.                                        |
| [history-api.md](history-api.md)                     | Reference   | Look up the synchronous text-read methods.                              |
| [saved-viewport.md](saved-viewport.md)               | Reference   | Look up `captureViewport` and `paintTerminalViewport`.                  |
| [font-geometry.md](font-geometry.md)                 | Reference   | Look up how cell size comes from the font.                              |
| [config-resolver.md](config-resolver.md)             | Reference   | Look up the host-only Ghostty config entry point.                       |
| [correctness.md](correctness.md)                     | Reference   | Read the conformance results and how to reproduce them.                 |
| [benchmarks.md](benchmarks.md)                       | Reference   | Read the CPU comparison with xterm.js and how to recompute it.          |
| [benchmark-tracing.md](benchmark-tracing.md)         | Reference   | Look up the WebGPU upload byte counters.                                |
| [comparison-provenance.md](comparison-provenance.md) | How-to      | Build a comparison bundle against a past commit.                        |
| [development.md](development.md)                     | How-to      | Build, test, and change the package.                                    |
| [adr/](adr/001-unpatched-pinned-ghostty-core.md)     | Decisions   | Read why the core is unpatched and why WebGPU stays instanced.          |

## Evidence kept in place

These files are measurement or proof records. Tests or CI read them, so their paths cannot change. They are not user documentation.

| Path                                      | Read by                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `benchmarks/mac-m1-2026-10-10/`           | `site/src/measurements.test.ts`, and `benchmarks.md` is generated from it. |
| `benchmarks/mac-m1-2026-10-08/`           | `site/src/measurements.test.ts`.                                           |
| `correctness-results.json`                | `site/src/correctness.ts`.                                                 |
| `config-resolver-feasibility.md`, `.json` | `scripts/config-resolver-proof/verify-evidence.ts`.                        |
