# Plan 014: Add headless parity and aliasable xterm-compatible packages

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update the parity ledger and this plan's
> status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- package.json bun.lock src packages scripts docs plans README.md`
> Confirm Plans 008–013 are DONE, regenerate the ledger, and inspect every planned package name for
> collision/authorization before creating publishable manifests.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 011–013 DONE
- **Category**: headless / packaging / distribution / DX
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

Matching a class inside `ghostty-webgpu` is not a package drop-in. Existing applications import
`@xterm/xterm`, `@xterm/headless`, addon package names, and `@xterm/xterm/css/xterm.css`. Since the
upstream npm scope is not ours, the honest replacement path is a set of behavior-compatible packages
that consumers install through package-manager aliases without changing application imports.

Headless is also a distinct public product. It must work without DOM/WebGPU globals and expose its
own xterm-compatible terminal contract.

## Target contract

Convert the repository to a Bun workspace while keeping the existing `ghostty-webgpu` package and
native API intact. Add planned compatibility packages:

- `@ghostty-webgpu/xterm`
- `@ghostty-webgpu/headless`
- `@ghostty-webgpu/addon-attach`
- `@ghostty-webgpu/addon-clipboard`
- `@ghostty-webgpu/addon-fit`
- `@ghostty-webgpu/addon-image`
- `@ghostty-webgpu/addon-ligatures`
- `@ghostty-webgpu/addon-progress`
- `@ghostty-webgpu/addon-search`
- `@ghostty-webgpu/addon-serialize`
- `@ghostty-webgpu/addon-unicode-graphemes`
- `@ghostty-webgpu/addon-unicode11`
- `@ghostty-webgpu/addon-web-fonts`
- `@ghostty-webgpu/addon-web-links`
- `@ghostty-webgpu/addon-webgl`

Do not publish or reserve names in this plan without explicit operator authorization. If the planned
npm scope is unavailable, STOP for a naming decision; do not silently choose a different public API.

Document drop-in installation through aliases, for example:

```json
{
  "dependencies": {
    "@xterm/xterm": "npm:@ghostty-webgpu/xterm@<version>",
    "@xterm/addon-fit": "npm:@ghostty-webgpu/addon-fit@<version>"
  }
}
```

With those dependency-only changes, existing source imports and CSS imports remain unchanged. The
claim is therefore “drop-in through package aliasing,” not ownership of or publication under the
upstream `@xterm` scope.

Every package has exact ESM/types/exports, compatible side-effect metadata, license/notices, engines,
README, source maps, and tarball contents. `@ghostty-webgpu/xterm` exports
`./css/xterm.css`. Addon packages export the official implementation when Plans 011–013 proved it
works unchanged, or the project adapter when they did not.

Plan 014 inherits nine partial Plan 008 package/declaration rows: `IViewportRange*`,
`ITerminalAddon`, `ITerminalAddon.activate`, and `Terminal.loadAddon`. Type fixtures may certify the
range declarations, but they must not hide runtime addon lifecycle gaps; packed browser and headless
fixtures must exercise the actual facade.

## Headless target

Implement `@xterm/headless` 6.0.0's public types and behavior through a browser-independent facade
under `src/xterm/headless/` or a package-local exact module. It must:

- construct synchronously and queue writes through the Plan 008 deferred write queue while native
  initialization proceeds, without DOM globals;
- expose the complete headless constructor/options/events/methods/buffer/parser/unicode/modes API;
- preserve write callback, resize, scrollback, marker, parser, Unicode, addon, and disposal behavior;
- work in Node 20+, Bun, workers, and bundlers without importing `document`, WebGPU, Canvas, CSS, or
  browser-only modules;
- support headless-compatible search, serialize, progress, clipboard-provider, and Unicode addons
  when the reference supports them.

## Commands you will need

| Purpose               | Command                                                 | Expected on success                         |
| --------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Headless differential | `bun run test:unit -- src/xterm/tests/headless.test.ts` | Node/Bun reference behavior matches         |
| Package type fixtures | `bun run test:xterm-types`                              | unchanged xterm consumer imports compile    |
| Alias app fixtures    | `bun run test:xterm-aliases`                            | vanilla/bundler/headless/addon fixtures run |
| Build workspaces      | `bun run build`                                         | all package artifacts build reproducibly    |
| Inspect tarballs      | `bun run pack:check`                                    | exports/files/licenses/deps are correct     |
| Parity/full gates     | `bun run xterm:parity && bun run verify`                | evidence current and repository green       |

## Scope

**In scope**:

- root `package.json`, `bun.lock`, TypeScript/build/test configs
- `packages/xterm/`
- `packages/headless/`
- one `packages/addon-*/` directory per pinned official addon
- no empty package directories; create each only with implementation and tests ready
- `src/xterm/headless/` browser-independent implementation
- `src/xterm/tests/headless.test.ts`
- package/type/alias fixtures under a dedicated test directory
- build and pack validation scripts
- root/public CSS compatibility file and export
- licenses/notices/readmes for every artifact
- README migration/alias guide, parity docs, and `plans/README.md`

**Out of scope**:

- Publishing, npm login, namespace creation, release tags, or external registry mutation without
  operator authorization.
- Claiming consumers can install `@xterm/*` directly from npm and receive this project.
- Shipping the xterm reference submodule or test-only upstream packages.
- DOM imports in headless output.
- Backward-compatibility shims for unreleased internal package layouts.

## Git workflow

- Work in the current worktree; do not branch, commit, push, publish, or open a PR unless requested.
- Keep package versions synchronized until a demonstrated reason requires independent versioning.
- Inspect tarballs before any future publication; never trust workspace development resolution alone.

## Steps

### Step 1: Lock the package architecture and names

Verify planned npm scope/name availability read-only and obtain operator authorization before any
external reservation/publication. Add root workspaces and a shared build configuration. Keep root
`ghostty-webgpu` publishable and avoid circular dependencies:

```text
ghostty-webgpu (native engine/API)
  -> @ghostty-webgpu/xterm (browser facade + CSS)
  -> @ghostty-webgpu/headless (headless facade)
  -> @ghostty-webgpu/addon-* (depends on compatible facade types as needed)
```

The diagram indicates dependency direction from compatibility packages toward the engine; addon
packages must not make the engine import them.

### Step 2: Implement the headless facade

Use Plan 007's released headless declarations as the exact inventory. Reuse browser-independent
option/event/queue/buffer/parser/Unicode adapters from Plans 008–009 by moving them into a shared
exact module only when both browser and headless import it. Do not make `src/core/` import facade
types.

Test sync construction, writes before readiness, callback order, resize/reflow, buffers, modes,
parser handlers, Unicode providers, markers, selection, serialization, disposal races, and runtime
failure against released `@xterm/headless`.

### Step 3: Build the xterm browser package and CSS export

Expose only xterm-compatible names from the compatibility package root, with Ghostty-specific
diagnostics under a documented secondary export. Export CSS at exactly `./css/xterm.css` and mark
that file as a side effect while keeping JavaScript tree-shakeable.

The browser package may depend on root `ghostty-webgpu` at the exact synchronized version. Confirm
WASM asset URLs resolve under Vite, Rollup, webpack, esbuild, Bun, and direct ESM hosting.

### Step 4: Build addon packages

Create each package from its Plan 011–013 decision. Match official package root exports, class/type
names, constructor signatures, module side effects, and runtime dependencies. Keep test-only official
packages out of production dependency graphs.

Where the official addon works unchanged, the compatibility package may re-export it only if its
runtime dependency resolves through the alias and its license/version are explicit. Otherwise ship
the project-native adapter.

### Step 5: Add unchanged-consumer fixtures

Create small fixtures copied from public usage patterns, not upstream source:

- vanilla browser app importing Terminal and CSS;
- app using fit, web-links, search, serialize, Unicode, image, and WebGL addons;
- app using custom key handler and TanStack-configurable native options where applicable;
- headless Node and Bun scripts;
- a bundler/code-splitting/worker asset fixture.

The fixture source imports only `@xterm/*`. Its package manifest swaps dependencies via aliases.
Run the same source against official and compatibility dependency sets and compare outputs.

### Step 6: Validate declarations and exports

Compile a broad released-xterm consumer type corpus with official types, then compatibility types,
without source edits. Check both directions where structural assignability is meaningful. Validate
runtime exports, conditional exports, CSS, ESM-only behavior, sourcemaps, declaration maps, and no
accidental DOM globals in headless.

### Step 7: Inspect production tarballs

Pack every workspace to a temporary directory and assert allowlisted contents, sizes, dependency
versions, licenses, notices, README, WASM ownership, CSS, declarations, and source maps. Reject
`references/`, tests, plans, fixtures, caches, upstream tarballs, or duplicate WASM payloads.

Install the tarballs—not workspaces—into clean fixture projects and rerun alias tests offline.

### Step 8: Update parity/package evidence

Mark headless and packaging rows compatible only after differential/type/tarball/fixture evidence
passes. Document exact alias instructions for npm, Bun, pnpm, and Yarn if their supported syntax
differs. Run the full gate and record artifact sizes/hashes.

## Test plan

- Headless differential tests run without DOM globals in Node and Bun.
- Type fixtures compile unchanged `@xterm/*` imports against both dependency sets.
- Browser/bundler fixtures verify WASM/CSS/addon resolution.
- Tarball tests inspect actual packed artifacts and reinstall them offline.
- Dependency scans prove no reference/test upstream package leaks into production.

## Done criteria

- [ ] Full headless 6.0.0 public contract has differential evidence and no DOM dependency.
- [ ] Browser/headless/addon workspace packages expose compatible runtime/types/CSS paths.
- [ ] Unchanged consumer source runs by changing dependency aliases only.
- [ ] Root native `ghostty-webgpu` API remains available and independently publishable.
- [ ] Tarballs contain only required artifacts, notices, and one intentional WASM ownership path.
- [ ] Reference source and test-only upstream packages do not ship.
- [ ] No external registry state was changed without operator authorization.
- [ ] All owned ledger rows are compatible; focused/parity/full gates pass.
- [ ] Plan 014 is DONE.

## STOP conditions

Stop and report if:

- The planned npm namespace is unavailable or publication authority is missing.
- Alias installation cannot preserve exact `@xterm/*` source imports in a supported package manager.
- Headless output imports DOM/WebGPU modules or cannot preserve sync public observables.
- Workspace resolution hides missing files/dependencies that fail from packed tarballs.
- An addon package requires shipping xterm private runtime code or the reference submodule.
- Multiple packages duplicate large WASM binaries in one consumer install without a deduplication
  design.

## Maintenance notes

- “Drop-in” always includes the qualifier “through package aliasing” because the upstream npm scope
  is not ours.
- Test packed artifacts in clean projects; workspaces are too forgiving.
- Browser and headless facades share behavior modules, never browser globals.
