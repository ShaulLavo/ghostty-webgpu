# Plan 010: Match xterm browser interaction, DOM, CSS, options, and accessibility

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update the parity ledger and this plan's
> status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src/dom src/render src/xterm demo package.json docs plans`
> Confirm Plans 006, 008, and 009 are DONE. Re-run the reference/parity generators and compare the
> live DOM/input/accessibility rows before editing.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plan 009 DONE
- **Category**: browser / interaction / accessibility / compatibility
- **Planned at**: commit `a7e7372`, 2026-08-24
- **Execution state**: BLOCKED — the independently authorized slice passes its automated browser
  matrix, but the mandatory three-run hardware benchmark exceeds the qualified CPU ceiling; Plan
  009 and the physical operator gate also remain unresolved

## Independent execution evidence — 2026-08-25

The operator authorized work independent of blocked Plan 009 and asked to circle back. That waiver
allowed the bounded work below; it did not satisfy or remove the dependency.

- The xterm entry now creates the released 6.0 DOM hierarchy while preserving native class hooks.
  The released stylesheet is copied byte-for-byte (SHA-256
  `854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6`), exported as
  `ghostty-webgpu/xterm.css`, and covered by package-consumer and differential DOM tests.
- An event-driven Canvas2D renderer consumes `RenderStateSource` directly. It uses Ghostty rows,
  Unicode, cursor, selection, styles, and damage, acknowledges native damage only after painting,
  and has no standing loop. Typed WebGPU capability failures select it automatically; programming
  failures still propagate. Diagnostics report `webgpu` or `canvas2d`.
- Native-backed `wordSeparator`, inactive cursor styles, `macOptionIsMeta`, `disableStdin`, and
  automated `screenReaderMode` behavior gained focused coverage. No visible-row proxy, shadow
  scrollback, JavaScript parser, or replacement terminal state was introduced.
- The unflagged browser matrix passed in Chromium, Firefox, and WebKit: each ran 37 tests with the
  one pre-existing, documented dispose-before-first-open lifecycle skip. Firefox and WebKit used
  the Canvas2D compatibility path.
- Automated accessibility checks match released public classes, roles, labels, row hooks, and
  dynamic enable/disable lifecycle. They do not claim VoiceOver, NVDA, IME, clipboard, held-key,
  high-DPI, or shadow-DOM operator evidence.

The hardware WebGPU benchmark used the same Apple `metal-3`, DPR 2, 200×50, 5-second warmup, and
30-second sample protocol as the qualified baseline. The active CPU ceiling is 9.35%.

| Scenario              | Run 1 | Run 2 | Run 3 | Three-run median | Ceiling | Result   |
| --------------------- | ----: | ----: | ----: | ---------------: | ------: | -------- |
| focused-blinking-idle |  0.1% |  0.1% |  0.1% |             0.1% |    0.3% | PASS     |
| unfocused-idle        |  0.0% |  0.0% |  0.0% |             0.0% |    0.1% | PASS     |
| burst-output          | 11.3% |  9.5% |  9.2% |             9.5% |   9.35% | **FAIL** |
| sustained-scroll      | 10.1% |  9.5% | 15.5% |            10.1% |   9.35% | **FAIL** |

Every idle run recorded zero frames, draws, rebuilt rows, instance uploads, atlas operations, and
atlas bytes. Every populated frame retained exactly two draws. Median glyph-churn atlas traffic was
70,871,473 bytes, still 99.636% below the Plan 001 baseline. Those structural results do not
override the CPU failure.

This triggers the explicit renderer-performance STOP condition after three comparable runs. Plan
010 is not DONE, its completion/full-parity gate is not claimed, and further implementation stops
pending an optimization/requalification decision. The Plan 009 dependency and physical operator
gate would remain even if the benchmark cleared.

## Why this matters

An API-compatible terminal is not a drop-in browser replacement if focus, keyboard, mouse,
selection, scroll, CSS sizing, accessibility, or unsupported-GPU behavior differs. This plan aligns
the browser-facing contract while retaining Ghostty as the terminal state authority and the
event-driven renderer architecture.

## Target contract

Match released xterm 6.0.0 for:

- documented DOM availability and CSS class/hooks under `open` and disposal;
- `css/xterm.css` layout behavior, container sizing, hidden textarea, viewport, screen, selection,
  helpers, accessibility tree, decorations, overview ruler, and focus states;
- keyboard output, `onKey`, custom-handler order, IME/dead key/AltGraph behavior, clipboard paste,
  `disableStdin`, `macOptionIsMeta`, and platform conventions;
- wheel, touch, pointer/mouse protocol reporting, custom wheel first refusal, fast/normal/smooth
  scroll sensitivities, and `scrollOnUserInput`;
- linear/word/line/column selection, `wordSeparator`, right-click behavior, modifier-forced
  selection, alt-click prompt movement, and selection events/ranges;
- cursor active/inactive styles, blink timing, visibility, minimum contrast, transparency, font,
  letter spacing, line height, theme, extended ANSI colors, scrollbar, and overview ruler options;
- `screenReaderMode`, keyboard navigation, live announcements, localization strings, and accessible
  row/cursor exposure;
- `documentOverride`, shadow DOM, resize/DPR/font loading, supported browser behavior, and renderer
  initialization/device loss.

Plan 010 inherits 113 partial Plan 008 rows covering the remaining option/theme/window/overview
types and behavior, DOM/open/disposal identities, custom handlers, focus/blur, exact input/paste and
`onData`/`onKey`/`onBinary`, renderer damage ranges, dimensions/resize, scrolling, and localization.
Transfer records ownership only; every row remains partial until this plan's differential and
physical browser gates pass. In particular, dispose-before-first-open DOM behavior is unresolved,
not silently accepted as another divergence.

All keyboard shortcut chords use the Plan 006 vanilla TanStack boundary. Terminal key packets still
use Ghostty. Focused ARIA widget navigation remains local semantic keyboard handling.

If any browser in xterm's documented support matrix cannot provide WebGPU in the supported test
environment, add a bounded event-driven Canvas2D compatibility renderer under `src/render/canvas/`.
It consumes the same `RenderStateSource` and fitted-font geometry, preserves transparency and
damage scheduling, and introduces no standing loop. Do not lower the browser matrix or tell users
to enable experimental flags to call the package a drop-in replacement.

## Commands you will need

| Purpose                 | Command                                                                                                                                                          | Expected on success                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Browser interaction     | `bun run test:browser -- src/xterm/tests/browser-interaction.browser.test.ts`                                                                                    | reference/target interaction matrix matches            |
| DOM/CSS contract        | `bun run test:browser -- src/xterm/tests/dom-contract.browser.test.ts`                                                                                           | dimensions/classes/focus/selection match               |
| Accessibility           | `bun run test:browser -- src/xterm/tests/accessibility.browser.test.ts`                                                                                          | roles, rows, cursor, announcements match               |
| Existing DOM regression | `bun run test:browser -- src/dom/tests/terminal-input.browser.test.ts src/dom/tests/terminal-ui.browser.test.ts src/dom/tests/pointer-selection.browser.test.ts` | native DOM tests pass                                  |
| Browser matrix          | `bun run test:xterm-browsers`                                                                                                                                    | Chromium, Firefox, and WebKit compatibility gates pass |
| Renderer benchmark      | `bun run bench:renderer`                                                                                                                                         | WebGPU path preserves qualified thresholds             |
| Parity/full gates       | `bun run xterm:parity && bun run verify`                                                                                                                         | evidence current and repository green                  |

## Scope

**In scope**:

- `src/dom/` input, elements, fit, pointer, selection, scrollbar, links, accessibility, terminal
- `src/render/` renderer lifecycle and an event-driven Canvas2D fallback if capability tests require
  it
- `src/xterm/terminal.ts`
- `src/xterm/options.ts`
- focused browser compatibility adapters under `src/xterm/`
- `src/xterm/tests/browser-interaction.browser.test.ts`
- `src/xterm/tests/dom-contract.browser.test.ts`
- `src/xterm/tests/accessibility.browser.test.ts`
- `scripts/browser-tests.ts` and a dedicated cross-browser launcher
- `vitest.browser.config.ts` or separate per-engine configs that do not weaken WebGPU tests
- `demo/` compatibility fixture
- `package.json`
- `README.md`
- parity docs, Phase 3 acceptance docs, and `plans/README.md`

**Out of scope**:

- Addon-specific behavior beyond the public hooks required by interaction.
- Pixel-for-pixel snapshots across operating systems/fonts.
- Replacing Ghostty terminal semantics with xterm private implementation details.
- Global keyboard listeners or React hotkeys.
- Dropping a documented browser because its GPU backend is inconvenient.
- Marking physical screen-reader/IME checks complete without an operator.

## Git workflow

- Work in the current worktree; do not branch, commit, push, or open a PR unless requested.
- Keep xterm-derived CSS/provenance review explicit. If CSS is adapted from MIT source, retain the
  required notice.
- Preserve native DOM tests as an independent regression suite.

## Steps

### Step 1: Characterize public DOM and interaction observables

Run the reference in light DOM and shadow DOM. Record elements/properties available immediately
after `open`, required class hooks, focus target, computed geometry, resize/DPR behavior, selection
ranges, scroll positions, and accessibility roles. Calibrate visual assertions with distinguishable
known-good colors before diagnosing paint.

Add differential helpers that normalize browser-generated ids and nondeterministic font pixels but
retain public geometry, class, event, and ARIA meaning.

### Step 2: Qualify the browser capability matrix

Run current stable Chromium, Firefox, and WebKit/Safari-equivalent Playwright coverage without
experimental user flags. Detect WebGPU/device capabilities at runtime. Use WebGPU when supported.

Where a documented target lacks usable WebGPU, implement the Canvas2D fallback described above.
Share fitted-font, row-instance preparation, selection/cursor styles, scheduling, and damage
acknowledgement rather than building a second terminal model. Add backend selection diagnostics but
no required consumer option.

**Verify**: the same basic terminal test opens, writes Unicode, selects, resizes, scrolls, and
disposes on every supported engine.

### Step 3: Align DOM and CSS contracts

Make the compatibility facade expose xterm-compatible public classes/structure and stylesheet
behavior without changing native `GhosttyWebGpuTerminal` class names unless both can coexist.
Support container resize, padding, overflow, scrollbar, overview ruler, helper textarea position,
selection overlay, decorations, and shadow roots.

Derive geometry from the Plan 005 fitted-font value. Never independently round CSS, pointer, canvas,
or native grid dimensions.

### Step 4: Complete keyboard and clipboard parity

Build a differential keyboard corpus covering printable keys, C0 controls, navigation, function and
numpad keys, application modes, mac option/meta, AltGraph, locks, physical sides, Kitty mode,
composition, dead/process keys, CJK/emoji, paste, and custom handler results.

Use vanilla TanStack only for host hotkey matching. Preserve Plan 006 ownership modes on the native
API. The xterm facade defaults/methods must behave like xterm, including `disableStdin`, `onKey`,
`onData`, `onBinary`, and browser default prevention.

### Step 5: Complete pointer, mouse, wheel, scroll, and selection parity

Compare click counts, drag directions, word separators, wrapped/wide/combining cells, rectangular
selection where exposed, mouse reporting modes, modifier overrides, wheel sensitivity, smooth
scroll cancellation, right click, alt-click cursor movement, touch, lost capture, blur, and disposal.

Keep one pointer owner at a time and shallow control flow. Do not let scrollbars, terminal mouse
reporting, selection, or links all act on one gesture.

### Step 6: Implement remaining mutable browser options

Map and differentially test every option owned by this plan, including option setters after open.
Honor init-only restrictions, renderer invalidation, cursor idle/blink timing, transparency, contrast,
theme/color validation, font reload, scrollbar/overview ruler, and `documentOverride`.

No accepted option may be inert. If the implementation cannot affect the documented behavior, keep
the row blocked and STOP rather than marking it compatible.

### Step 7: Match accessibility behavior and run physical gates

Implement screen-reader rows, cursor, labels, live output bounds, keyboard navigation, localization,
and high-output suppression consistent with xterm. Automated ARIA assertions are necessary but not
sufficient.

Update the physical checklist for VoiceOver/Safari/macOS and NVDA/Firefox or Edge/Windows, plus IME,
clipboard permissions, held-key repeat, high-DPI resize, and shadow DOM. The operator performs and
records these gates; the executor must not self-certify them.

### Step 8: Requalify performance and update parity evidence

Run native WebGPU hardware benchmarks and bounded fallback benchmarks. WebGPU must preserve the
Plan 005 two-draw and idle contracts. Canvas fallback must render only scheduled damage and remain
idle with zero standing work.

Update all owned ledger rows, then run the browser matrix and full gate.

## Test plan

- Differential browser tests cover public DOM, geometry, options, event order, input, selection,
  mouse, wheel, scroll, and accessibility.
- Existing native tests remain green and prove no compatibility-only behavior leaked into core.
- Cross-browser tests cover real layout/paint on Chromium, Firefox, and WebKit.
- Hardware benchmark covers WebGPU; smoke/perf ceilings cover any fallback.
- Physical operator evidence covers screen readers, IMEs, clipboard permissions, and held keys.

## Done criteria

- [ ] Every browser/input/DOM/CSS/selection/scroll/options/accessibility row owned by this plan is
      compatible with evidence.
- [ ] Current documented xterm browsers open and operate without experimental flags.
- [ ] A fallback renderer exists if required and remains event-driven.
- [ ] Vanilla TanStack owns host hotkey matching; raw protocol input remains Ghostty-owned.
- [ ] Shadow DOM, DPR, resize, fonts, transparency, themes, scrollbars, and overview ruler work.
- [ ] Automated accessibility tests pass and physical items are truthfully recorded.
- [ ] Native WebGPU benchmark remains within qualified thresholds.
- [ ] Browser matrix, parity gate, and `bun run verify` pass.
- [ ] Plan 010 is DONE.

## STOP conditions

Stop and report if:

- A documented target browser cannot run WebGPU and a fallback would be rejected or require a
  standing render loop.
- DOM compatibility requires replacing public elements after they were exposed.
- Any xterm option would be accepted but inert.
- Input parity would route IME/text through hotkey matching or lose physical Kitty lifecycle.
- Pointer ownership cannot be made exclusive and deterministic.
- Accessibility could only be claimed from automated ARIA snapshots without operator evidence.
- Renderer performance thresholds fail after three comparable hardware runs.

## Maintenance notes

- Keep compatibility CSS/classes in the facade layer; native class names remain free to evolve.
- Browser support is a tested contract, not a README guess.
- Every user-facing option needs a behavior test at construction and, where mutable, after open.
