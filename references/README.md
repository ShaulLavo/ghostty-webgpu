# xterm.js reference

This directory pins the upstream material used by the xterm compatibility program. The source
checkout is a Git submodule at `xterm.js`, from
`https://github.com/xtermjs/xterm.js.git`, detached at
`08ad9a4de9252f387cc5fbf68aa3d98e0ba8a0b7`. It is the forward-reference snapshot, not
application code.

The certification baseline is the released `@xterm/xterm@6.0.0` and
`@xterm/headless@6.0.0` packages. Both record release tag commit
`f447274f430fd22513f6adbf9862d19524471c04`. Exact package integrities, declaration hashes,
entry points, and pinned addon versions live in [`xterm-manifest.json`](./xterm-manifest.json).
Addon packages are read from their published artifacts, while the same paths in the submodule are
forward-drift inputs. `@xterm/addon-web-fonts@0.1.0` was published from a later commit and declares
an `@xterm/xterm@^6.1.0-beta.86` peer; the ledger records it without pretending it is compatible
with the 6.0.0 core baseline.

Published bytes, not tag-source package metadata, define the certification surface. In particular,
`@xterm/headless@6.0.0` declares the absent `lib/xterm.mjs` module while shipping
`lib-headless/xterm-headless.mjs`, and `@xterm/addon-ligatures@0.10.0` declares an absent CommonJS
entry while shipping its ESM entry. The static export inventory also records the undocumented
`HTMLSerializeHandler` export from addon-serialize. These are upstream observables to match or
account for, not defects to normalize away in the reference snapshot.

## Updating the baseline

Treat an update as one atomic review:

1. Select an immutable released xterm version and source commit.
2. Update the submodule gitlink, release packages, and manifest identities together.
3. Run `bun run xterm:reference`, `bun run xterm:reference-pack`, and
   `bun run xterm:parity:update`.
4. Review every added, removed, and changed ledger row and update its status, owner plan, and
   evidence.
5. Run `bun run verify` before changing the certified version.

A moving branch or a submodule-only update is invalid. The inventory scripts read declarations and
package metadata directly; they never execute upstream build or lifecycle scripts.

## Provenance and packaging

xterm.js and its published packages are MIT licensed. Behavioral and public-type compatibility may
be reimplemented independently. Copying or adapting source requires an explicit license and notice
review, including updates to `THIRD_PARTY_NOTICES.md` and the adapted file where required.

The submodule is excluded from the package `files` allowlist, TypeScript build, formatter traversal,
and production bundles. It must never appear in an npm artifact. The generated parity ledger is
project documentation; it is not a parity claim by itself.
