# 001. Build the wasm core from unpatched, pinned upstream Ghostty

Status: accepted
Date: 2026-10-24 (recorded after the fact; the decision predates this file)

## Context

Ghostty's `libghostty-vt` is the part of Ghostty that parses terminal bytes and keeps screen state. Upstream builds it to WebAssembly with `zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding` and exposes a C API. The other Ghostty-in-the-browser project, ghostty-web, builds Ghostty from a fork patch that hand-writes its own wasm API (`patches/ghostty-wasm-api.patch` at ghostty-web `9e4e126d`).

This library needs more than the C API gives, such as frame building and the callbacks that the browser host handles. That code has to live somewhere.

## Decision

Build `ghostty-vt.wasm` from one pinned revision of the official Ghostty repository, with no patches and no fork. Keep every addition in a separate Zig module, `bridge.wasm` (`scripts/bridge.zig`), that builds against the official C headers and imports the core's memory. `ghostty-vt.provenance.json` records the revision, the Zig version, and the build recipe, and `bun run build:wasm` rebuilds the file from them.

## Alternatives considered

- **Patch or fork Ghostty, as ghostty-web does.** It would let us reach internals directly. It loses because every upstream change becomes a merge, and "same parser as Ghostty" stops being checkable by anyone outside the project.
- **Write our own parser, as xterm.js does.** It would skip Zig and wasm. It loses because the point of the library is Ghostty's behavior, not a lookalike.

## Consequences

- Upgrading Ghostty means changing the pin and rebuilding, then rerunning the correctness suite. Nothing needs rebasing.
- Upstream behavior is inherited, bugs included. Both current [correctness](../correctness.md) failures reproduce in the pinned upstream core, and the report counts them as failures.
- Anything the C API cannot express has to be built in `bridge.wasm` or in JavaScript. That constrains the frame builder.
- Rebuilding needs Zig 0.16.0 or newer, so contributors who only touch TypeScript can ignore the build and use the checked-in wasm.
