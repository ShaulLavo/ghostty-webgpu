# Ghostty config appearance

Server-side Node and Bun applications can resolve the current user's Ghostty appearance through
the host-only entry point:

```ts
import { resolveGhosttyConfigAppearance } from 'ghostty-webgpu/config-resolver'

const result = await resolveGhosttyConfigAppearance()
if (result.status === 'ready') {
  console.log(result.appearance)
}
```

Optional assembled host distributions target the following matrix. Browser builds do not
require these binaries. A browser package verification does not qualify their availability:

| OS    | Architecture | Compatibility                  |
| ----- | ------------ | ------------------------------ |
| macOS | `arm64`      | macOS 13.0 or newer            |
| macOS | `x64`        | macOS 13.0 or newer            |
| Linux | `arm64`      | fully static; no libc required |
| Linux | `x64`        | fully static; no libc required |

Using an assembled host distribution does not require an installed Ghostty or Zig toolchain.
A `ready` result contains schema and pinned
upstream revisions, a bounded diagnostic count, one canonical appearance revision, and light/dark
profiles with bounded colors, palette entries, surface values, and fidelity markers. Each profile
reports `exact` when every native value maps directly; `best-effort` is accompanied by ordered
degradation markers for values such as cell-relative colors, Display-P3 conversion, blur, or macOS
glass.

An `unavailable` result contains only one fixed reason: `config-not-found`, `invalid-output`,
`output-limit`, `resolver-failed`, `timeout`, or `unsupported-platform`. Failures do not expose
config text, paths, theme names, environment values, diagnostics, commands, stderr, or native
output.

This subpath is intentionally unavailable to browsers. Server bundlers must externalize
`ghostty-webgpu/config-resolver`; do not include it in a client bundle. The browser-safe package root
does not import the resolver or its native assets.

## Host verification

Use `bun run build:host`, `bun run verify:host` and `bun run test:package:host` to qualify an
assembled host distribution. These commands check native artifacts and provenance. Missing host
binaries are not a successful host qualification.
