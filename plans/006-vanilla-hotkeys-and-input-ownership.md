# Plan 006: Add vanilla hotkey arbitration and explicit input ownership

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- package.json bun.lock src/dom src/term src/index.ts README.md`
> The completed renderer plans and their uncommitted worktree changes are expected. Compare every
> file and public type named below against the live worktree before editing. A conflicting input API
> or a second keyboard owner is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plan 005 DONE
- **Category**: input / public API / dependency
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

The DOM input controller currently mixes three responsibilities: terminal key encoding, browser
text/IME/paste transport, and hard-coded host shortcuts. That makes copy and paste difficult to
override and gives consumers no clean way to own keyboard input themselves.

Use the framework-agnostic `@tanstack/hotkeys` package for shortcut parsing and matching. Do not use
`@tanstack/react-hotkeys`; this library has no React runtime. Raw terminal input must remain on the
existing Ghostty path because it depends on physical `KeyboardEvent.code`, modifier sides, locks,
AltGraph consumption, composition state, and Kitty press/repeat/release actions. TanStack hotkeys
arbitrates host commands; it does not replace the terminal protocol encoder.

## Current state

- `src/dom/input.ts` directly owns `keydown`, `keyup`, composition, `input`, paste, focus, blur, and
  document visibility listeners on the hidden textarea.
- `handleKey` reserves paste and macOS copy with local predicates, then calls
  `TerminalSession.key(TerminalKeyInput)` for supported physical key codes.
- `suppressedShortcutCodes` prevents a claimed keydown from leaking repeat or release packets into
  Kitty keyboard mode.
- `GhosttyWebGpuTerminalOptions` has no keyboard policy.
- `GhosttyWebGpuTerminal` exposes `sendInput` and `paste`, but not the session's normalized `key`
  method.
- `@tanstack/hotkeys` is not installed. Version `0.8.0` is the current vanilla package at planning
  time and has a runtime dependency on `@tanstack/store`.
- TanStack's `HotkeyManager` constructor is private and its public instance is global. Destroying or
  mutating that singleton from one terminal would affect unrelated terminal/application consumers.

## Target contract

Add the exact runtime dependency `"@tanstack/hotkeys": "0.8.0"`. Pin the pre-1.0 version exactly;
upgrade it only through an explicit compatibility pass.

Add these public concepts in `src/dom/types.ts` and export them from `src/index.ts`:

```ts
export type TerminalHotkeyDecision = 'claim' | 'passthrough'

export interface TerminalHotkeyContext {
  readonly event: KeyboardEvent
  readonly getSelection: () => string | undefined
  readonly hasSelection: () => boolean
  readonly paste: (data: TerminalInputData) => TerminalInputResult
  readonly sendInput: (data: TerminalInputData) => TerminalInputResult
}

export interface TerminalHotkeyBinding {
  readonly hotkey: RegisterableHotkey
  readonly id: string
  readonly onTrigger: (context: TerminalHotkeyContext) => TerminalHotkeyDecision
  readonly preventDefault?: boolean
  readonly stopPropagation?: boolean
}

export interface GhosttyWebGpuTerminalKeyboardOptions {
  readonly shortcuts?: false | readonly TerminalHotkeyBinding[]
}
```

Extend `GhosttyWebGpuTerminalOptions` with:

```ts
readonly keyboard?: false | GhosttyWebGpuTerminalKeyboardOptions
```

The semantics are:

- `keyboard` omitted: install DOM terminal input and the package's default shortcut policy.
- `keyboard: { shortcuts: false }`: retain raw keys, IME, and paste transport, but install no
  optional host-command bindings. Browser paste reservation remains transport behavior so a paste
  event cannot also emit a terminal key packet.
- `keyboard: { shortcuts: bindings }`: replace the default host-command bindings completely. Do
  not merge hidden defaults behind the user's list.
- `keyboard: false`: install no keydown, keyup, composition, input, or paste listeners. The user
  owns keyboard/text transport. Focus/blur reporting and document-visibility renderer lifecycle
  remain installed and are not disabled by this option.

The default binding table preserves today's observable behavior:

- macOS `Mod+C` claims only when a terminal selection exists and invokes the configured/default
  selection-copy policy;
- the platform paste chord is reserved without preventing the first keydown, allowing the browser's
  native `paste` event to deliver clipboard data;
- a claimed physical code suppresses repeats and its matching release so Kitty never sees a partial
  lifecycle;
- AltGraph never matches copy or paste.

Compile each `RegisterableHotkey` once at controller construction with TanStack's
`normalizeRegisterableHotkey` and `parseHotkey`, then match keydown events with
`matchesKeyboardEvent`. Use an explicit platform derived from the textarea's owning window. Do not
call `getHotkeyManager`, `HotkeyManager.getInstance`, or `destroy`; the terminal must not own global
TanStack state or depend on listener registration order.

Add this high-level method so manual owners can feed the existing native encoder:

```ts
key(input: TerminalKeyInput): TerminalInputResult
```

It delegates to `TerminalSession.key` after the same lifecycle guard as `sendInput` and `paste`.
This is a normalized protocol API, not a `KeyboardEvent` adapter.

Focused widget controls are not shortcut chords. Keep scrollbar Arrow/Page/Home/End handling and
link-overlay Enter/Escape behavior local to those accessible widgets. Record this boundary in the
README so “all hotkeys use TanStack” is not misread as “all keyboard events are global shortcuts.”

## Commands you will need

| Purpose               | Command                                                                | Expected on success                               |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| Input browser focus   | `bun run test:browser -- src/dom/tests/terminal-input.browser.test.ts` | shortcut/raw/manual ownership matrix passes       |
| Session unit focus    | `bun run test:unit -- src/term/tests/session.test.ts`                  | normalized key encoder contract remains unchanged |
| DOM integration focus | `bun run test:browser -- src/dom/tests/terminal-ui.browser.test.ts`    | focus, copy, links, scrollbar remain compatible   |
| Dependency/type check | `bun run typecheck`                                                    | vanilla TanStack types and public exports compile |
| Full gate             | `bun run verify`                                                       | all repository gates pass                         |

## Scope

**In scope**:

- `package.json`
- `bun.lock`
- `src/dom/input.ts`
- a focused `src/dom/hotkeys.ts` pure integration module if extraction keeps nesting shallow
- `src/dom/types.ts`
- `src/dom/terminal.ts`
- `src/dom/tests/terminal-input.browser.test.ts`
- `src/dom/tests/terminal-ui.browser.test.ts`
- `src/term/types.ts` only if a readonly public type import needs adjustment
- `src/term/session.ts` only for delegation typing; do not change encoding
- `src/term/tests/session.test.ts`
- `src/index.ts`
- `README.md`
- `plans/README.md`

**Out of scope**:

- React, React hooks, or `@tanstack/react-hotkeys`.
- Replacing Ghostty's physical-key encoder with `event.key` matching.
- Global/window/document hotkeys; bindings are scoped to this terminal's hidden textarea.
- Shortcut sequences, recording UI, a command palette, persisted settings, or a global registry.
- Changing scrollbar and link-overlay accessibility keyboard semantics.
- Implementing the xterm compatibility facade; Plan 008 consumes this boundary.
- Claiming the physical Phase 3 operator gate passed.

## Git workflow

- Work in the current worktree. Do not create a branch or worktree unless the operator requests it.
- Do not commit, push, or open a pull request unless the operator requests it.
- Preserve all existing renderer changes and plan records.

## Steps

### Step 1: Install and isolate the vanilla dependency

Add exact `@tanstack/hotkeys@0.8.0` to runtime `dependencies`. Confirm the lockfile records
`@tanstack/store`. Import only exact public functions/types used by the integration.

Create a small DOM-local hotkey compiler/matcher if needed. It may hold an immutable ordered list of
compiled bindings, but no module-level mutable state, subscriptions, or singleton ownership.

**Verify**: `bun run typecheck` resolves the vanilla package without React or peer dependencies.

### Step 2: Separate terminal lifecycle listeners from keyboard ownership

Move focus, blur, and document visibility handling into an always-installed lifecycle controller or
an equivalent shallow helper. It must still reset transient modifier/suppression state when the
input controller exists, report DEC focus mode, and pause/resume renderer work.

When `keyboard: false`, `open()` must still create/focus the textarea and report focus changes, but
dispatching key, composition, input, or paste events must produce no terminal data. Disposal removes
every listener exactly once.

**Verify**: add a browser test for manual ownership plus focus/visibility continuity.

### Step 3: Replace hard-coded shortcut matching with TanStack matching

Build the default copy and paste binding definitions at input-controller construction. Compile
custom bindings in declaration order and reject duplicate non-empty ids. A supplied list replaces
defaults. `shortcuts: false` produces an empty optional binding list.

Run shortcut arbitration only on non-composing keydown. A binding that returns `passthrough` allows
later bindings and then raw Ghostty handling. A binding that returns `claim` records `event.code`,
applies its explicit/default prevent/propagation policy, and stops. Treat callback exceptions as
`input.hotkey.<id>` errors and claim the lifecycle to avoid leaking half an action into the PTY.

Paste reservation is a transport rule evaluated with the same TanStack matcher before optional
bindings. It claims the lifecycle but leaves the initial browser default enabled. Preserve the
current paste event and `insertFromPaste` fallback paths.

Do not let `event.defaultPrevented` alone decide ownership; a host may have prevented an unrelated
browser default while still expecting terminal input.

**Verify**: browser coverage for default copy/paste, custom replacement, passthrough, callback
failure, duplicate ids, AltGraph, dead/composing keys, repeat, release, and disposal.

### Step 4: Add the manual normalized-key escape hatch

Expose `GhosttyWebGpuTerminal.key(input)` and export its existing input/result types. Delegate
without copying readonly input containers. Validate lifecycle exactly like `sendInput` and `paste`.

Test the method against real WASM with Kitty keyboard mode enabled. The output for press, repeat,
and release must match the DOM-owned path byte-for-byte.

**Verify**: focused session and browser input tests pass.

### Step 5: Document the ownership modes and xterm seam

Add README examples for default, custom shortcuts, `shortcuts: false`, and `keyboard: false` plus
manual `key`/`sendInput`/`paste`. State that TanStack owns shortcut matching while Ghostty owns
terminal protocol encoding. Mention the exact pre-1.0 pin.

Document that the future xterm `attachCustomKeyEventHandler` adapter will run before this arbitration
and map xterm's boolean result onto the same claim/passthrough seam; do not implement the facade here.

### Step 6: Run the full gate

Run the focused commands first, then `bun run verify`. Update the Plan 006 status only after all
checks pass. Leave the physical operator checklist pending.

## Test plan

- Unit/type coverage proves no React dependency or global HotkeyManager ownership.
- Browser tests cover the complete ownership matrix and exact key lifecycle suppression.
- Real-WASM tests prove manual and DOM key paths emit identical Kitty packets.
- Existing IME, CJK, emoji, dead-key, replacement text, clipboard, focus, and AltGraph tests remain
  unchanged or become stricter.
- Disposal tests prove terminal instances do not share mutable hotkey state.

## Done criteria

- [ ] Exact `@tanstack/hotkeys@0.8.0` is a runtime dependency; no React adapter is installed.
- [ ] Every configurable shortcut is parsed/matched by vanilla TanStack functions.
- [ ] No terminal touches TanStack's global `HotkeyManager` singleton.
- [ ] Raw terminal key encoding retains physical code, modifier side/lock, AltGraph, IME, and Kitty
      press/repeat/release fidelity.
- [ ] Default, replacement, shortcut-disabled, and fully manual input modes behave as documented.
- [ ] `GhosttyWebGpuTerminal.key` provides normalized manual control.
- [ ] Focus/visibility lifecycle continues when keyboard transport is disabled.
- [ ] Claimed shortcuts never leak repeat or release packets.
- [ ] Focused tests and `bun run verify` exit 0.
- [ ] Plan 006 is marked DONE in `plans/README.md`.

## STOP conditions

Stop and report if:

- The current TanStack public API no longer provides stable parse/normalize/match functions at the
  pinned version.
- Implementing the policy requires owning or destroying the global HotkeyManager singleton.
- A shortcut can claim keydown but cannot reliably suppress repeat/release for the same physical
  code.
- `keyboard: false` would also disable DEC focus reporting or renderer visibility lifecycle.
- IME, AltGraph, dead keys, or browser paste would be routed through hotkey callbacks.
- Any solution changes the native Ghostty key packet encoder or introduces React.
- A full gate failure cannot be attributed and fixed without weakening existing coverage.

## Maintenance notes

- Upgrade TanStack Hotkeys deliberately while it is pre-1.0; rerun the ownership matrix on every
  version change.
- Keep hotkey arbitration terminal-instance-local even if a future manager API allows construction.
- A shortcut match and a terminal key are different concepts. Preserve that boundary.
