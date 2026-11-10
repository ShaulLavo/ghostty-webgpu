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

The local checks passed through the shared runner:

- `bun install --frozen-lockfile --cache-dir /work/cache/bun` left the lock unchanged.
- `bunx vitest run scripts/ios-browser-source.test.ts scripts/ios-browser-dependency.test.ts`
  passed 11 tests across two files.
- `bunx vitest list --filesOnly --json=.../ci-discovery.json` used the actual default
  CI configuration and discovered both pin-test files among 170 Node test files.
  No discovery configuration change was needed.
- `bunx vitest run scripts/ios-browser --exclude scripts/ios-browser-controls.test.ts`
  passed 276 tests across 49 files. The omitted control file executes Chromium;
  it is not skipped or changed in source or CI.
- `bun run build`, both optional package builds, and `bun run typecheck` passed.
- `bun run lint` passed with existing warnings. No warning is in the changed files.
- `bun run format:check` and `bun run --cwd site docs:check` passed.

The direct public-archive check also accepted the runtime archive and rejected
same-length corrupt bytes. Logs, the rerunnable digest check, discovery output,
and the resource ledger are under
`/work/reports/wave-20261110/ios-suites/ghostty-118-source/`.

These are local source and integration checks, not a complete GitHub CI verdict.
The parent owns the required `verify`, four browser shards, and `sites` checks,
independent review, merge, and native-lane handoff.

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
Cleanup checked the actual PC after all consumers stopped. The owned scratch,
root and workspace dependency links, and all three generated build directories
were removed. No listener remained on the source-control fixture ports. Shared caches and pre-existing services are preserved. No device,
route, container, persistent server, or additional checkout is created.
