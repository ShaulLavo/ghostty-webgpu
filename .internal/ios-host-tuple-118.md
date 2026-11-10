# iPhone host tuple 118

Status: Approved source and CI adoption. Native acceptance is unchanged.

The selected-file iPhone host now pins the public runtime and relay 0.0.118 from
`6e0608451a3f89c1fa0e4f17dacdc6edc5cbc900`, host interface 2. The development
installation also pins programs/base 0.0.20 and its five program families. Program
guests retain source `3050f69d810fe7c851e487135517698b5dfd93e5`; the program release
tools and acceptance metadata use the runtime commit.

The input closure is
`/work/reports/wave-20261110/ios-suites/waffle-lifecycle-release118/SUPPORTED-TUPLE.json`.
The active identities are in `scripts/ios-browser-dependency.ts`. `package.json`
and the regenerated `bun.lock` consume the public archives, with one runtime
resolution shared by the relay, base, and all five program families.

## Verification

Baseline `bunx vitest run scripts/ios-browser-source.test.ts` passed all nine tests
on 0.0.114 before editing the pins. Public runtime, relay, and base archives were
downloaded and checked against the closure's byte counts and SHA-256 digests.
Their SHA-512 values match the new lock entries.

The new `scripts/ios-browser-dependency.test.ts` checks development-only direct
pins, archive integrity in the lock, installed host interfaces and versions,
complete base family URLs, and the single installed runtime graph. It uses real
package resolution, including Bun's isolated transitive dependency layout.

Final command results are recorded before handoff. Logs and the resource ledger
are under `/work/reports/wave-20261110/ios-suites/ghostty-118-source/`.

## Limits

This change runs source and CI checks only on the PC through the shared heavy
runner. It performs no Mac, simulator, native, GUI, or browser execution. No relay
server or guest program is started.

The original browser tests, accepted files, source hashes, clocks, assertions,
and retries are unchanged. Historical receipts keep their original tuple.
Displayed-pixels and sprites platform failures remain unchanged. Canvas-ZWJ
assessment belongs to another child. No package version is bumped. This adoption
does not prove allocator repair, physical-reader closure, a historical WebKit
cause, new key input, or a new Safari WebSocket qualification profile.

## Resources

Only this prepared worktree is edited or built. Task dependencies live behind
its `node_modules` link in an owned `/work/tmp/ghostty-118-source-*` directory.
Workspace dependency links and build outputs are task-owned and removed after
verification. Shared caches and pre-existing services are preserved. No device,
route, container, persistent server, or additional checkout is created.
