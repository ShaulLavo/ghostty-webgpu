# ghostty-webgpu docs map

Tutorials and task guides are on [ghostty.shaulavo.dev/docs](https://ghostty.shaulavo.dev/docs/). Their sources are in `site/src/content/docs/`. This folder holds concepts, reference, and contributor pages.

## Pages

- [concepts.md](concepts.md) (explanation): see how bytes become pixels and how a renderer is chosen.
- [status.md](status.md) (reference): check stability, browser support, and known gaps.
- [troubleshooting.md](troubleshooting.md) (how-to): fix a blank terminal, a missing `.wasm`, or a denied clipboard.
- [use-in-your-app.md](use-in-your-app.md) (how-to): link the built package into your app and ship its `.wasm` files.
- [integration.md](integration.md) (how-to): wire a terminal to a WebSocket PTY and learn the emoji width rule.
- [api.md](api.md) (reference): look up exact behavior of frames, scrollback, geometry, and extensions.
- [hotkeys.md](hotkeys.md) (reference): look up `attachTerminalHotkeys`.
- [history-api.md](history-api.md) (reference): look up the synchronous text-read methods.
- [saved-viewport.md](saved-viewport.md) (reference): look up `captureViewport` and `paintTerminalViewport`.
- [font-geometry.md](font-geometry.md) (reference): look up how cell size comes from the font.
- [config-resolver.md](config-resolver.md) (reference): look up the host-only Ghostty config entry point.
- [correctness.md](correctness.md) (reference): read the conformance results and how to reproduce them.
- [benchmarks.md](benchmarks.md) (reference): read the CPU comparison with xterm.js and how to recompute it.
- [benchmark-tracing.md](benchmark-tracing.md) (reference): look up the WebGPU upload byte counters.
- [comparison-provenance.md](comparison-provenance.md) (how-to): build a comparison bundle against a past commit.
- [development.md](development.md) (how-to): build, test, and change the package.
- [adr/](adr/001-unpatched-pinned-ghostty-core.md) (decisions): read why the core is unpatched and why WebGPU stays instanced.

## Data files

These files are measurement and proof data. Tests and CI read them by path. They are not user documentation.

- `benchmarks/mac-m1-2026-10-10/`: read by `site/src/measurements.test.ts`, and `benchmarks.md` is generated from it.
- `benchmarks/mac-m1-2026-10-08/`: read by `site/src/measurements.test.ts`.
- `correctness-results.json`: read by `site/src/correctness.ts`.
- `config-resolver-feasibility.md`, `.json`: read by `scripts/config-resolver-proof/verify-evidence.ts`.
