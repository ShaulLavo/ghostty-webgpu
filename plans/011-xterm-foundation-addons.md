# Plan 011: Match xterm attach, clipboard, fit, web-links, and progress addons

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update the parity ledger and this plan's
> status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src/xterm src/dom package.json docs plans`
> Confirm Plans 008–010 are DONE and the reference identity is current. First test the released
> official addons against the facade; reimplement only when public compatibility cannot make them
> work without upstream private services.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: Plan 010 DONE
- **Category**: addons / compatibility / integration
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

These addons cover the common integration path: connect a WebSocket, fit a container, expose safe
web links, service OSC 52 clipboard requests, and observe shell progress. They are the first proof
that the facade supports real xterm ecosystem behavior rather than only hand-written method tests.

## Target contract

Match the pinned public typings and released behavior for:

- `AttachAddon` and `IAttachOptions.bidirectional`;
- `ClipboardAddon`, `Base64`, `BrowserClipboardProvider`, `IBase64`, and `IClipboardProvider`;
- `FitAddon`, `fit`, and `proposeDimensions`;
- `WebLinksAddon` and `ILinkProviderOptions`;
- `ProgressAddon`, `progress`, `onChange`, and `IProgressState`.

For each addon, use this decision order:

1. Run the official released addon unchanged against the facade.
2. If it uses only public API and passes, certify interoperability and do not duplicate it.
3. If its published runtime depends on xterm private services, implement a behavior-compatible
   adapter under `src/xterm/addons/` for packaging in Plan 014. Do not emulate private service names
   on the core facade merely to satisfy one addon.

All addon instances support activate-once, idempotent disposal, terminal-owned disposal after
`loadAddon`, and failure rollback. No addon owns global listeners after disposal.

## Commands you will need

| Purpose             | Command                                                                     | Expected on success                             |
| ------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Addon unit tests    | `bun run test:unit -- src/xterm/tests/foundation-addons.test.ts`            | codecs, progress, lifecycle, failure cases pass |
| Addon browser tests | `bun run test:browser -- src/xterm/tests/foundation-addons.browser.test.ts` | socket/clipboard/fit/links match reference      |
| Official interop    | `bun run test:xterm-addons -- foundation`                                   | released addons or adapters pass one contract   |
| Parity/full gates   | `bun run xterm:parity && bun run verify`                                    | evidence current and repository green           |

## Scope

**In scope**:

- `src/xterm/addons/attach.ts`
- `src/xterm/addons/clipboard.ts`
- `src/xterm/addons/fit.ts`
- `src/xterm/addons/web-links.ts`
- `src/xterm/addons/progress.ts`
- only create adapter files proven necessary; do not create empty placeholders
- `src/xterm/tests/foundation-addons.test.ts`
- `src/xterm/tests/foundation-addons.browser.test.ts`
- official addon dev dependencies pinned to manifest versions
- `package.json` and `bun.lock`
- compatibility demo fixtures
- README, parity docs, and `plans/README.md`

**Out of scope**:

- Search, serialize, Unicode, ligatures, fonts, image, or WebGL addons.
- Browser clipboard access without explicit permission/user gesture.
- Automatic URL navigation without a safe activation handler.
- A production WebSocket reconnect policy; AttachAddon mirrors xterm's connection only.
- Packaging/publishing addon names; Plan 014 owns artifacts.

## Git workflow

- Work in the current worktree; do not branch, commit, push, or open a PR unless requested.
- Do not copy official source unless behavior cannot be implemented cleanly and MIT notice review is
  completed. Prefer public-contract reimplementation.

## Steps

### Step 1: Test official addon interoperability

Pin the exact released addon versions recorded by Plan 007 as dev-only references. Load each against
released xterm and the target facade through the same harness. Capture any private-service access
with a stack and source path. Decide official reuse versus adapter per addon and record it in the
ledger.

### Step 2: Implement AttachAddon behavior

Forward socket message strings/ArrayBuffers/Blobs in arrival order, respect `bidirectional`, send
terminal data only while active/open, and remove listeners on addon/terminal disposal. Match behavior
for already-open/closing/closed sockets, binary types, send failures, and activation misuse.

Use a local test WebSocket server; do not mock the terminal or socket event ordering.

### Step 3: Implement clipboard/base64 behavior

Match UTF-8 base64 validation, selection names, provider sync/async results, OSC 52 read/write/query,
permission failures, limits, and disposal. Default browser provider uses the owning window's
clipboard and never silently escalates permission.

Integrate with the existing default-deny clipboard policy. Compatibility options may opt in, but
core security defaults stay explicit and ledger differences must be documented until aligned.

### Step 4: Implement FitAddon behavior

Use Plan 005 canonical fitted geometry. `proposeDimensions` is pure/read-only and returns undefined
for unmeasurable/detached containers exactly like the reference. `fit` calls `resize` only for valid
changed dimensions and does not install its own ResizeObserver or standing timer.

### Step 5: Implement WebLinksAddon behavior

Adapt the existing link resolver to xterm viewport ranges, custom regex, hover/leave callbacks,
default handler, protocol rules, wrapped/wide/combining text, async invalidation, and disposal.
Preserve native OSC 8 precedence where xterm documents it.

### Step 6: Implement ProgressAddon behavior

Register the exact ConEmu progress sequence through Plan 009's parser. Normalize states/values,
emit only actual changes in reference order, allow public setter/reset, and unregister on disposal.
Never infer progress by scanning output text.

### Step 7: Differentially certify and update the ledger

Run lifecycle, happy-path, malformed-input, failure, and disposal scenarios against the reference.
Update each addon row only after its official implementation or replacement adapter passes. Record
which official packages can be used unchanged.

## Test plan

- Unit tests cover base64, progress normalization, lifecycle, and failure rollback.
- Browser tests use real WebSocket events, clipboard provider boundaries, real layout fit, and link
  pointer/keyboard behavior.
- Interop tests run official packages unchanged before choosing adapters.
- Disposal tests assert zero residual socket, parser, DOM, or terminal subscriptions.

## Done criteria

- [ ] Official-vs-adapter decision and evidence exists for all five addons.
- [ ] Attach is ordered, bidirectional-configurable, and leak-free.
- [ ] Clipboard/base64 matches public behavior without weakening permission policy silently.
- [ ] Fit uses canonical geometry and installs no hidden observer/timer.
- [ ] Web links match ranges, callbacks, security, and disposal.
- [ ] Progress uses parser registration and exact change semantics.
- [ ] All owned ledger rows are compatible with evidence.
- [ ] Focused addon, parity, and full gates pass.
- [ ] Plan 011 is DONE.

## STOP conditions

Stop and report if:

- An official addon requires private xterm services and the proposed response is to expose fake
  `_core` internals globally.
- Clipboard compatibility would require implicit permission escalation or unsafe default writes.
- Fit would create a second geometry/rounding authority.
- Web links would navigate unsafe URIs without explicit user policy.
- Progress cannot register at the native parser boundary.
- Disposal leaves external listeners or async callbacks alive.

## Maintenance notes

- Prefer official addon interoperability when it truly uses public API.
- Keep adapters independent; one addon file, one public responsibility, exact imports.
- External permissions and sockets remain explicit resource boundaries in tests and docs.
