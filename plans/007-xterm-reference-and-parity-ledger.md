# Plan 007: Pin the xterm reference and establish the parity ledger

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- package.json bun.lock .github scripts docs plans README.md`
> Existing renderer plans and worktree changes are expected. Confirm no `references/xterm.js`
> checkout or parity ledger already exists before adding one.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: Plan 005 DONE
- **Category**: reference / conformance / documentation
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

“Full xterm parity” is otherwise an unbounded moving target. The project needs an immutable source
reference, a released compatibility baseline, a machine-readable inventory of every public surface,
and differential tests that compare stable observables rather than implementation details.

At planning time, xterm.js `master` is commit
`08ad9a4de9252f387cc5fbf68aa3d98e0ba8a0b7`; the latest public core release is `6.0.0` at tag
`f447274f430fd22513f6adbf9862d19524471c04`. Pin both facts. The released package is the claimable
compatibility target; pinned master is the forward-reference source used to detect upcoming drift.

## Target contract

Add xterm.js as a Git submodule at `references/xterm.js`, checked out at
`08ad9a4de9252f387cc5fbf68aa3d98e0ba8a0b7`. Add `references/README.md` outside the submodule with:

- upstream URL and pinned commit;
- released certification baseline and tag commit;
- update procedure;
- license/provenance rules;
- statement that reference source is excluded from package artifacts and is not application code.

Add a machine-readable `docs/xterm-parity.json` and generated `docs/xterm-parity.md`. Every row must
contain:

```text
id, area, package, symbol, behavior, referencePath, referenceCommit,
targetStatus, implementationPath, evidence, ownerPlan, notes
```

Allowed status values are `missing`, `partial`, `compatible`, `blocked`, `not-applicable`. “Full
parity” means no `missing`, `partial`, or `blocked` rows for the certified release and every
`compatible` row names an automated or physical evidence artifact. `not-applicable` requires a
written reason and cannot hide a public xterm API.

Inventory all public declarations from:

- `typings/xterm.d.ts` for `@xterm/xterm`;
- the generated `@xterm/headless` 6.0.0 package declaration;
- every `addons/addon-*/typings/*.d.ts` directory in the pinned source;
- `css/xterm.css`, documented DOM classes, constructor/open lifecycle, and supported browsers;
- package exports and addon package names.

The pinned addon set is: attach, clipboard, fit, image, ligatures, progress, search, serialize,
unicode-graphemes, unicode11, web-fonts, web-links, and webgl.

## Commands you will need

| Purpose                 | Command                                                      | Expected on success                                   |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Reference identity      | `bun run xterm:reference`                                    | source/tag/package identities match manifest          |
| Ledger generation       | `bun run xterm:parity`                                       | JSON validates and Markdown is current                |
| Reference package check | `bun run xterm:reference-pack`                               | upstream public typings/exports snapshot is current   |
| Focused conformance     | `bun run test:unit -- src/xterm/tests/parity-ledger.test.ts` | inventory completeness checks pass                    |
| Full gate               | `bun run verify`                                             | reference tree is excluded and repository stays green |

The executor may choose equivalent script names only if no xterm scripts exist yet; update this plan
and `package.json` together so later plans have stable commands.

## Scope

**In scope**:

- `.gitmodules`
- `references/xterm.js` gitlink
- `references/README.md`
- root formatter/linter ignore files if the submodule is traversed
- `.github/workflows/ci.yml`
- `package.json`
- `bun.lock` only if a released reference package is pinned as a dev dependency
- `scripts/xterm-reference.ts`
- `scripts/xterm-parity.ts`
- `docs/xterm-parity.json`
- `docs/xterm-parity.md`
- `src/xterm/tests/parity-ledger.test.ts` or the exact compatibility-test home established here
- `README.md`
- `plans/README.md`
- `plans/008-xterm-terminal-facade.md` for corrections proven by the pinned differential baseline

**Out of scope**:

- Copying xterm implementation into `src/`.
- Implementing compatibility rows.
- Editing files inside the xterm submodule.
- Tracking moving `master` without an immutable commit.
- Claiming parity from matching TypeScript names alone.
- Publishing under the upstream-owned `@xterm` npm scope.

## Git workflow

- Work in the current worktree. Do not create a branch or worktree unless the operator requests it.
- Do not commit, push, or open a pull request unless the operator requests it.
- A submodule normally records a gitlink and `.gitmodules`; do not vendor the nested `.git` history
  as ordinary files.
- Preserve xterm's MIT license. If any source is later adapted rather than behaviorally reimplemented,
  retain required notices in `THIRD_PARTY_NOTICES.md` and the adapted file.

## Steps

### Step 1: Add and pin the reference checkout

Add `https://github.com/xtermjs/xterm.js.git` at `references/xterm.js` as a submodule and checkout
exact commit `08ad9a4de9252f387cc5fbf68aa3d98e0ba8a0b7`. Do not leave it on a branch. Record the release
tag commit `f447274f430fd22513f6adbf9862d19524471c04` separately.

Update CI checkout to initialize submodules recursively. Ensure package `files` still excludes
`references/`. Add root ignore configuration for formatter/linter only if their normal repository
walk enters the submodule; never weaken checks for project-owned files.

**Verify**: reference identity script rejects a missing checkout, dirty reference, wrong URL, wrong
HEAD, or mismatched manifest.

### Step 2: Snapshot the released public declarations

Use the published `@xterm/xterm@6.0.0` and `@xterm/headless@6.0.0` packages as the certification type
baseline. Read addon package versions from each pinned source `package.json` and record them; do not
assume all addon semvers equal the core semver.

The script may download/read package tarballs into an ignored cache, but generated public inventory
must be deterministic from the lock/manifest and work offline once dependencies/reference are
present. Do not commit `node_modules`, tarballs, or built upstream output.

### Step 3: Generate the complete ledger

Parse declarations or maintain a reviewed manifest generator that emits one row per public class,
interface member, option, event, method, addon API, CSS entry, package export, and browser-support
claim. Stable row ids must survive regeneration.

Seed implementation status from the live repository. Existing Ghostty capabilities such as write,
resize, selection, links, WebGPU rendering, Kitty keyboard, and accessibility may be `partial`; they
are not `compatible` until their xterm semantics and tests match. Mark unavailable buffer/parser/
unicode/decorations/addon/headless surfaces `missing` or `blocked` truthfully.

Group generated Markdown by:

1. core constructor/lifecycle/options/events;
2. terminal methods and input;
3. buffer/cell/modes/parser/unicode;
4. selection/markers/decorations/links/joiners;
5. DOM/CSS/accessibility/browser support;
6. each official addon;
7. headless;
8. packaging/import compatibility;
9. VT behavior, performance, and manual gates.

### Step 4: Add parity-test fixtures

Create a minimal test harness that can instantiate the released reference and the compatibility
target behind one driver interface. At this stage it only needs smoke observables: constructor
defaults, pre-open properties, write callback ordering, open/dispose lifecycle, rows/cols, and event
subscription disposal. Mark tests skipped only when the ledger row is explicitly `missing`; each
skip must name the row id so the generator can count it.

Do not compare private fields, renderer pixels, timing-sensitive animation frames, or exact DOM tree
internals unless upstream documents them as public behavior.

### Step 5: Make parity drift a CI gate

Fail CI if:

- generated Markdown differs from JSON;
- any upstream public declaration lacks a ledger row;
- a `compatible` row lacks evidence;
- an evidence path/test no longer exists;
- a plan marked DONE still owns `missing`, `partial`, or `blocked` rows;
- the submodule or released package identity drifts.

Do not fail simply because remaining future rows are honestly `missing`; the final certification
plan owns that zero-gap gate.

### Step 6: Document update and legal policy

Document an atomic upgrade flow: select a new released xterm version, update submodule commit,
regenerate inventory, review added/removed/changed rows, update all affected plans/tests, then change
the certified version. A moving submodule without ledger regeneration is forbidden.

State that behavior and public types may be reimplemented. Source copying requires explicit license
notice review. Keep the reference out of npm artifacts and production bundles.

### Step 7: Run the full gate

Run all reference, ledger, focused, and full verification commands. Record baseline counts by area in
the execution notes and mark Plan 007 DONE.

## Execution notes

- Pinned source: `08ad9a4de9252f387cc5fbf68aa3d98e0ba8a0b7`; released 6.0.0 tag:
  `f447274f430fd22513f6adbf9862d19524471c04`.
- Ledger inventory: 938 rows — 684 released TypeScript surfaces, 48 released CSS selectors, 81
  package/entry/runtime-export surfaces, 13 reviewed behavior/environment claims, and 112
  `not-applicable` forward-drift rows.
- Released rows by area: core lifecycle/options/events 163; terminal methods/input 22;
  buffer/cell/modes/parser/Unicode 76; selection/markers/decorations/links/joiners 50; DOM/CSS/
  accessibility/browser 53; headless 224; packaging/imports 81; VT/performance/manual 3. Addon rows:
  attach 6, clipboard 19, fit 9, image 21, ligatures 7, progress 9, search 27, serialize 23,
  unicode-graphemes 4, unicode11 4, web-fonts 7, web-links 8, and webgl 10.
- Forward drift is separate from the release claim. Pinned master adds or changes 40 core, 21
  headless, 13 addon API rows, and 12 CSS selectors; it removes or supersedes 3 core, 4 headless, 8
  addon API rows, and 11 CSS selectors. Exact duplicate master declarations are merged by semantic
  signature.
- Published-package observables are preserved rather than repaired: headless's declared ESM path
  and ligatures' declared CommonJS path are absent, addon-serialize has an undocumented runtime
  export, and web-fonts' peer range targets a later core prerelease.
- Differential smoke tests record the current lifecycle and ordering gaps. Released xterm writes
  complete `returned -> callback -> onWriteParsed`; its second browser `open` is a no-op and disposal
  retains disconnected DOM references.
- Plan 008 now follows those release observations and keeps master-only `screenElement`,
  `dimensions`, and `onDimensionsChange` out of the 6.0.0 facade contract.

## Test plan

- Identity tests cover URL, source commit, release commit, dirty state, and package versions.
- Schema tests cover allowed statuses, unique ids, valid plan ownership, evidence paths, and complete
  upstream declaration inventory.
- Generator snapshot proves Markdown is deterministic.
- Initial differential smoke tests establish the harness without pretending missing behavior passes.
- Package tarball inspection proves `references/` is absent.

## Done criteria

- [x] `references/xterm.js` is a clean submodule pinned to the exact planned commit.
- [x] The 6.0.0 released core/headless baseline and exact addon versions are recorded.
- [x] Every public declaration/addon/CSS/package surface has a parity row.
- [x] Current compatibility status is honest and every row names a future owner plan.
- [x] Differential smoke harness runs the reference and target through one driver.
- [x] CI detects reference, inventory, evidence, and plan-status drift.
- [x] Reference source is absent from published artifacts and production bundles.
- [x] License/provenance and update procedures are documented.
- [x] `bun run verify` exits 0 and Plan 007 is DONE.

## STOP conditions

Stop and report if:

- The remote commit/tag no longer resolves to the planned identities.
- Repository policy rejects submodules; do not silently replace it with an unpinned clone or source
  copy.
- Public package declarations cannot be tied to exact released package versions.
- The ledger generator would need to execute untrusted upstream build scripts.
- CI cannot initialize the reference without weakening the main verification gate.
- A public API is deliberately omitted from the ledger because it appears difficult or private
  internals are mistaken for public API.

## Maintenance notes

- The release baseline is what can be certified. Pinned master is a drift oracle, not a moving
  promise.
- A type-compatible symbol is still `partial` until behavioral evidence exists.
- Never update the submodule alone; reference, inventory, tests, and certified version move together.
