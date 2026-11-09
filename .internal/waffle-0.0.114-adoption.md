# Public Waffle runtime adoption

Status: Approved. CPU source adoption verified on November 9, 2026. Parent review and merge remain pending.

## Scope and ownership

This T3 worktree and branch are the only source write location. The fixed PR 116 head
`0d69040be1d27f8086adf9b9ce04be5b25eaf283` and PR 121 head
`bcd8cb19b63dc8b999d23bde0eb951b1419a3619` were cherry-picked onto main
`6a7979f68`. Their branches, bodies, review history, and earlier results remain unchanged.
The parent coordinator independently reviews and merges this replacement PR.

The runtime-only package is Waffle 0.0.114, source
`341bf1452d98e280a5c718af2775a839ff4042fa`, host interface 2.
The anonymous public download is 3,580,810 bytes with SHA-256
`84a624f85f6843449ca2c96c113cb9609e8f4df634df17082e46246413f8245e`.
No program family is needed by the framework host or page bridge. No unpublished program
archive, SDK patch, source overlay, or old-shape fallback is permitted.

## Throughput checkpoint

- Blocking first steps. Read both PR discussions and inspect the downloaded runtime's real
  framework host, page, trace, and result declarations before changing consumers.
- Independent workstreams. None. The release identity, lock, and interface checks form one adoption.
- Shared mutable state. Only this worker writes this worktree. Existing branches stay untouched.
- Smallest safe decomposition. One worker integrates and verifies the bounded adoption.
  Architecture exploration and delegation are omitted under the explicit no-children assignment.

The data model is the shipped `FrameworkHost`, `FrameworkObservation`, `FrameworkResult`, and
`TesterTraceCapture` contract. Lazy snapshots and trace capture remain direct calls to that API.
Collector delivery, ordinary framework outcomes, and final trace settlement keep separate owners.

## Resource ledger

Before setup this worktree had no installed dependencies or build outputs. No task server,
browser, device, remote session, route, container, or native process existed or is required.
The pre-existing comfy-gallery heavy-runner server is unrelated and stays untouched.
The PC had no owner reservation and no queued heavy jobs. CPU builds and suites use the
installed heavy runner. Mount and free space for `/work` were checked before installation.

Owned scratch is `/work/tmp/ghostty-waffle114-b047534d`. It holds the downloaded archive,
extracted inspection package, private install cache, and disposable check logs. Test harnesses
retain their existing `finally` teardown. Build and install outputs are recorded before removal;
only outputs created by this worker may be removed. The author worktree stays for parent integration.

## Evidence limits

No native, Mac, browser, Safari, physical iPhone, pixel, memory-release, or original-suite
execution is claimed. Earlier development-only results remain historical and are not new proof.
Every original clock, assertion, suite body, and helper remains unchanged.

## Integration decisions

The public archive has the reviewed lazy snapshot factories, final trace capture, and absolute
cleanup deadline contract. Both integrated consumers typecheck directly against those shipped
types. No adapter, old-shape branch, or SDK change is needed. The installed SDK matches every
file in the verified archive. Bun adds only its own `.bun-tag` marker.

The historical source-equality test originally used `git show` on an unmerged PR commit.
Normal CI uses a shallow checkout, so that object is not available there. The test now pins
SHA-256 identities for the same five complete files, including the recorded negative fixture.
The source bodies, manifests, clocks, and assertions are unchanged from the fixed heads.
This follows the existing native source identity checks rather than weakening their coverage.

Laziness Protocol kept the adoption to the pin and identity checks rather than adding a
compatibility layer. Model the Domain kept framework results and reporting trace settlement
as the released types. Prove It Works required the public archive, installed host controls,
and plain Node source import rather than the earlier development-only runs. Build the Lever
made the complete-source preservation check runnable in ordinary shallow CI.

## CPU verification

All commands run on the PC through `/work/heavy-runner/current/run.js`, using `--host local`.
Build commands use class `build`, the broad CPU selection uses `suite`, and bounded source
checks use `light`. Scratch, npm cache, and temporary files stay under the owned scratch root.
No browser engine or native simulator was launched. Local tests did not update the original
completion count of 24 or claim any additional original completion.

The following checks passed:

- `bun install --backend copyfile` with a private `BUN_INSTALL_CACHE_DIR` generated the public
  runtime lock. The only lock changes are its URL and SHA-512 integrity. A final frozen copyfile install
  reported no changes and preserved the lockfile hash.
- `bun run build` and `bun run verify:extensions`. The extensions passed 102 line-editor and
  22 shader unit tests, types, builds, and both package import checks.
- `bun run typecheck`, `bun run lint`, and `bun run format:check`. Existing unrelated lint
  warnings remain. No warning names an adoption or integrated reporting file.
- `bun run --cwd site docs:check`. Samples compiled and seven site checks passed.
- `bun scripts/verify-config-resolver-artifacts.ts --state bootstrap`.
- `checkFrameworkArchive` accepted the anonymously downloaded public 0.0.114 archive.
  The release tag resolves through its annotated tag to the declared source commit.
- `vitest run --maxWorkers=4 --exclude scripts/ios-browser-controls.test.ts` passed 1,909
  tests. One existing Fregat allocation-instrumentation-dependent test remains skipped by
  its unchanged condition. No skip or exclusion was added to source or CI.
- `vitest run scripts/ios-browser-controls.test.ts -t 'published host and actual attached provider reject'`
  passed all four CPU-only installed-host controls. The twelve browser cases in that mixed
  file were not selected locally. Existing CI retains them unchanged.
- `bun run bench:compare:test` passed 485 CPU checks.
- `node --test scripts/autoresearch-checkpoint.test.mjs` passed four checks.
- `bun test ./.internal/worker-delta-prototype/codec.test.ts` passed two checks.
- The explicit focused selection below passed 63 tests through normal Vitest discovery.
- The sixteen packaging tests in `scripts/package-tarball.test.ts` and
  `scripts/release-artifacts.test.ts` passed as part of the broad CPU selection.

```sh
vitest run scripts/ios-browser-reporting.test.ts scripts/ios-browser-reporting-source.test.ts scripts/ios-browser-records.test.ts scripts/ios-browser-reporting-host.test.ts scripts/ios-browser-reporting-controller.test.ts scripts/ios-browser-reporting-data.test.ts scripts/ios-browser-reporting-owner.test.ts scripts/ios-browser-reporting-ownership-host.test.ts scripts/ios-browser-reporting-page.test.ts scripts/ios-browser-reporting-trace-source.test.ts scripts/ios-browser-source.test.ts
```

`bun run pack:release` packed all three built packages. An owned temporary consumer installed
those exact tarballs with `npm install --ignore-scripts --no-audit --no-fund`, then ran these
commands from its own directory:

```sh
node "$SOURCE/node_modules/typescript/bin/tsc" --noEmit --strict --target ES2023 --module ESNext --moduleResolution Bundler --lib ES2023,DOM consumer.ts
node line-editor.mjs
node shaders.mjs --installed
```

`consumer.ts` is the unchanged `scripts/fixtures/release-consumer.ts.txt`. The package smoke
scripts are the existing addon scripts. A plain Node import check loaded the relocated root
and core exports without constructing a terminal, validated all four Wasm assets, and confirmed
Waffle is absent from the production installation. `validateReleaseArtifacts` accepted the
three artifact identities and checksums. The temporary consumer was removed by its EXIT trap.
The full `test:package:built` command was deliberately not run because it starts a browser.
Its existing hosted CI check remains unchanged.

The first package probe invoked TypeScript from the checkout and hit TS5112 because that
working directory has a tsconfig. The probe was corrected to run inside the temporary consumer,
matching the existing package checker. No product change or compiler flag bypass was needed.

Exact-source comparisons also passed against fixed PR 121 for all five reporting fixture
files and the inherited-name regressions. Comparisons against main passed for `src`, packages,
benchmarks, original stage manifests, source hashes, process clocks, options, and result guards.

## Final resource cleanup

All temporary test consumers and loopback servers settled. Cleanup removed and
checked absence of the 758 MiB installed dependency graph, 775 MiB inspection scratch and private
caches, and generated root and addon builds plus packaging outputs. The final host check found no ignored install or build directory left in this
worktree and no listener on the owned port 19764.
No task-owned server, browser, native session, remote checkout, route, or container is retained.
The shared comfy-gallery service and global caches remain untouched. The 138 MiB author worktree and
committed notes stay for the parent to review and integrate, then the parent retires that worktree.
