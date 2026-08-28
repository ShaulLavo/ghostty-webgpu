# Phase 3 acceptance

Status: **PASS — physical operator gate completed on 2026-08-28 (IDT).**

This file separates evidence collected through headed browser control from checks that require a
person using the physical keyboard, macOS input methods, clipboard UI, and VoiceOver. A control
result is not a final manual PASS. Phase 3 must not be marked complete until every item in
“Physical operator gate” is recorded PASS.

## Environment

| Item                                | Observed value                                                           |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Date                                | 2026-08-23 (IDT)                                                         |
| OS                                  | macOS 26.4 (25E246), Darwin 25.4.0 arm64                                 |
| Browser                             | Headed hardware Chromium 151.0.0.0                                       |
| GPU                                 | Apple M1, 8 cores, Metal 4                                               |
| WebGPU adapter used by the renderer | vendor `apple`, architecture `metal-3`, fallback `false`, subgroup 32–32 |
| Display                             | Built-in 2560×1600 Retina                                                |
| Terminal tools                      | Vim 9.1, htop 3.5.3, lazygit 0.64.1, Python 3.13.12                      |

The demo captured the renderer's actual adapter from its one `requestAdapter` call. It did not
make a second probe request. The acceptance snapshot also recorded a focused, visible document,
the active terminal textarea, device-pixel ratio, diagnostics, renderer metrics, and scheduler
events.

## Current closeout candidate

Pin evidence was reconciled on 2026-08-28 before reopening the physical operator gate. The
remaining checks must run against this package state; the historical Phase 3 artifact below must
not be restored.

| Item                             | Reconciled value                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Package                          | `ghostty-webgpu@0.1.1` worktree based on `3c3e07edef23cdbbe141410432e89276cb6504b2` |
| Ghostty source                   | `c8554f28e0efe2f5595f32020371c34b25ec628f`                                          |
| `ghostty-vt.wasm` SHA-256        | `dfb171587bc11b6610fb95d3b583926d51287f5d6e528c45ff2aa05218608a97`                  |
| `bridge.wasm` SHA-256            | `47fae389c94f2545b2026d756256272b65f978d97feabae21b9171ad4b54b63f`                  |
| `ghostty_type_json` ABI manifest | schema `1`; wasm32, freestanding, little-endian, 4-byte pointers and usize          |
| Platform's installed package     | registry `0.1.0`; both wasm artifacts byte-identical to the candidate               |

The package-version difference is packaging-only for this gate: Platform's installed `0.1.0` and
the current `0.1.1` worktree carry the same Ghostty revision and identical terminal and callback
wasm bytes. Platform's dependency pin therefore remains unchanged. Against the candidate, the
focused real-wasm ABI suite passed 34 tests across `input.test.ts`, `runtime.test.ts`, and
`terminal.test.ts`; this does not satisfy any physical row.

Using the package-pinned Bun 1.3.10, the root and demo frozen installs, package build, Node import,
demo typecheck, 34 focused ABI tests, and 34 demo authorization/protocol tests all passed on the
2026-08-28 closeout-preflight host. The lockfiles and both wasm artifacts remained unchanged. This
Linux preflight did not evaluate or promote a headed macOS operator row.

## Automated gates

| Gate                                                                                | Result                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------- |
| `bun install --cwd demo --frozen-lockfile`                                          | PASS — no changes                            |
| `bun run --cwd demo typecheck`                                                      | PASS                                         |
| `bun run test:unit -- demo/tests/authorization.test.ts demo/tests/protocol.test.ts` | PASS — 2 files, 34 tests                     |
| `CI=true bun run test:browser`                                                      | PASS — 74 unique browser tests; no new skips |
| `bun run verify`                                                                    | PASS — 135 unit + 74 browser tests           |
| `bun run bench:renderer`                                                            | PASS — true DPR2 CPU and atlas thresholds    |
| `node -e "import('./dist/index.js')"`                                               | PASS — browser-free import                   |
| Browser-global grep of `src/core` and `src/term`                                    | PASS — no matches                            |
| `git diff --exit-code -- bun.lock`                                                  | PASS — root lock unchanged                   |
| `git diff --exit-code -- ghostty-vt.wasm`                                           | PASS — artifact unchanged                    |
| `git diff --check`                                                                  | PASS                                         |
| `npm pack --dry-run --json`                                                         | PASS — demo/docs excluded                    |

The authorization checks cover the valid same-origin upgrade and rejection of a foreign Host,
foreign Origin, and missing token. HTTP responses use no permissive CORS. The protocol checks
cover binary PTY data, bounded resize messages, malformed input, and unknown message types.

The renderer refactor's final hardware qualification is recorded in
[`renderer-refactor-baseline.md`](./renderer-refactor-baseline.md). Against the corrected true-DPR2
baseline, burst and sustained CPU medians were 8.9% versus 8.5%, a 4.71% regression within the 10%
allowance. Populated frames remained exactly two draws, idle runs recorded zero renderer work, and
median glyph-churn atlas traffic fell 99.633% from the Plan 001 baseline. This automated evidence
does not satisfy any physical operator item below.

At Phase 3 acceptance, the package was pinned to Ghostty revision
`da5ddcb0857c0e4ddb32f7a089911e9038d040f3`, matching `src/core/version.ts` and the intentional
ABI-bump commit that produced the checked-in wasm. `ghostty-vt.wasm` retained SHA-256
`1e2734515d9c3a88b00b5667edd5052aa00e6778a57b5b4fdaa7d43d9a821ace` throughout Phase 3.
Current shipped-artifact provenance is recorded in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

### Plan 010 browser compatibility controls — 2026-08-25

The unflagged xterm compatibility suite passed in Chromium, Firefox, and WebKit with 37 tests and
one pre-existing lifecycle skip per engine. Firefox and WebKit exercised the event-driven Canvas2D
fallback over the same Ghostty render-state authority. Focused DOM/CSS, input/selection, and
automated accessibility differentials passed against released xterm 6.0.0.

This is supplemental automated evidence only. The initial three-run WebGPU hardware benchmark
failed its active CPU ceiling at 9.5% burst and 10.1% sustained medians versus 9.35% allowed. A
bounded retry then coalesced adjacent instance ranges, reducing a full 50-row frame from 100
`GPUQueue.writeBuffer` calls to two without changing bytes, rows, frames, or draws. Sustained scroll
passed at an 8.8% three-run median, but burst remained above the ceiling at 9.8%, so Plan 010 stays
BLOCKED. No physical screen-reader, IME, clipboard, held-key, high-DPI, or shadow-DOM item below was
promoted.

## Headed Chromium control evidence

These observations are supplemental `CONTROL PASS` results, not substitutes for the physical
operator gate.

### Renderer refactor readiness — 2026-08-24

The corrected build loaded in the headed demo at `http://127.0.0.1:4173/` on the hardware Apple
Metal adapter with no browser warnings, errors, or WebGPU validation messages. Calendar rows,
digits, punctuation, prompt glyphs, cursor, and selection were visually aligned at DPR 2 and after
a live refit to fractional DPR 2.2; the pre-refactor mixed character heights were not observed.

With cursor blink disabled, the built-in 11-second idle sampler reported `quiescent`. Diagnostics
showed no pending frame, timer, or link resolution, and the snapshot retained the exact two-draw
contract with 8 submitted frames and 16 draws. This result establishes readiness for the physical
operator checklist; it does not mark any item below PASS.

| Case                   | Exact command                                    | Controlled observations                                                                                                                                                                                                                             | Result       |
| ---------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Vim                    | `vim -Nu NONE -n /tmp/ghostty-webgpu-phase3.txt` | Inserted three lines; exercised arrows, Ctrl/Alt, mouse mode, pointer cursor movement, viewport resize, focus loss/recovery, and Shift-drag selection override. The override painted native terminal selection instead of entering Vim visual mode. | CONTROL PASS |
| htop                   | `htop`                                           | Exercised arrows, F1 help, F4 text filter, pointer selection, wheel input, live resize, and F10 exit.                                                                                                                                               | CONTROL PASS |
| lazygit                | `lazygit`                                        | Exercised panel/list navigation, a typed-and-cancelled command prompt, pointer selection, wheel input, alternate-screen resize, and clean exit.                                                                                                     | CONTROL PASS |
| Kitty keyboard checker | `python3 demo/kitty-keyboard-check.py`           | Observed distinct Kitty press/release packets for printable, Shift, Ctrl, Alt, Super, arrows, Shift+ArrowLeft, and F2 input. A real held-key repeat remains pending.                                                                                | CONTROL PASS |

### Post-exit idle observations

Cursor blink was disabled, the terminal textarea remained focused, and the document remained
focused and visible for every observation. Each interval was at least 10 seconds.

| Exited case   | Submitted frames before/after | Draws before/after | Uploaded bytes before/after | Pending frame/timer/link | Result       |
| ------------- | ----------------------------: | -----------------: | --------------------------: | ------------------------ | ------------ |
| Vim           |                     120 / 120 |          240 / 240 |       3,822,464 / 3,822,464 | none / none              | CONTROL PASS |
| htop          |                     165 / 165 |          330 / 330 |       7,306,368 / 7,306,368 | none / none              | CONTROL PASS |
| lazygit       |                     200 / 200 |          400 / 400 |     10,100,864 / 10,100,864 | none / none              | CONTROL PASS |
| Kitty checker |                     252 / 252 |          504 / 504 |     13,234,304 / 13,234,304 | none / none              | CONTROL PASS |

The scheduler trace was empty throughout every blink-off interval. With focused cursor blink
enabled, one sample observed eight timer fires, eight rAF requests, eight rAF callbacks, and eight
successful frame submissions. Disabling blink returned diagnostics to no pending timer or frame.

### Links, clipboard, selection, and accessibility semantics

- An OSC 8 link and a plain URL both resolved to accessible link overlays and invoked the explicit
  activation callback on Command-click.
- OSC 52 was visibly denied under the default policy. After explicit opt-in, the known test payload
  completed an asynchronous browser clipboard write; the callback never claimed synchronous
  completion.
- A physical-style paste action inserted the known clipboard payload exactly once into the shell
  input line. Physical Command-C/Command-V confirmation remains pending.
- Two hundred numbered lines produced scrollback. Wheel input moved `aria-valuenow` from 199 to
  156, the scrollbar exposed min `0`, max `199`, vertical orientation, and its track changed the
  viewport to row 143.
- Dragging across historical rows painted a multi-row native selection.
- The accessibility mirror exposed a `Terminal screen` list, one ordered list item per visible row,
  cursor-position text, and an accessible vertical scrollbar. Spoken VoiceOver navigation remains
  pending.

## Loopback PTY lifecycle

The demo used binary browser WebSocket frames and a byte-preserving Node sidecar around
`@lydell/node-pty`. A `bun-pty` 0.4.10 experiment was rejected because its string-only API decoded
PTY bytes `ff fe` as replacement characters and re-encoded them as
`ef bf bd ef bf bd`.

The server bound to `127.0.0.1`, used a fresh per-run token, and rejected unauthorized upgrades.
Stopping the server after live sessions left no demo server, sidecar, shell, or checker process.

## Physical operator gate

All required rows are recorded **PASS**.

- [x] PASS — held printable `f` produced the physical press/repeat/release lifecycle, including
      Kitty repeat (`:2`) and release (`:3`) packets.
- [x] PASS — physical Shift, Ctrl, Option, and Command modifiers, arrows, and a function key were
      exercised and observed in the checker.
- [x] PASS — on 2026-08-28 the operator invoked the macOS-owned Command-Tab and Command-Space
      actions. The browser exposed only Command lifecycle events and the passive PTY capture
      remained empty: no Meta, Tab, or Space packet leaked.
- [x] PASS — on 2026-08-28 the operator used macOS Pinyin to compose and visibly commit `你好`
      once. The passive trace captured exactly `e4 bd a0 e5 a5 bd`; `ni hao` remained visible
      preedit and produced no PTY bytes.
- [x] PASS — on 2026-08-28 the operator inserted `🧪` once through Character Viewer. The passive
      trace captured exactly one `f0 9f a7 aa` packet, and the operator subsequently confirmed
      visible emoji rendering in the headed terminal.
- [x] PASS — on 2026-08-28, under the ABC input source, physical Option-N then `a` visibly
      committed `ã` once. The passive trace captured exactly `c3 a3`; repeated tilde preedit
      updates produced no PTY bytes.
- [x] PASS — on 2026-08-28 the operator copied the known native selection
      `GW055-CLIP-7Q9X` with physical Command-C and pasted it with physical Command-V. The passive
      trace captured exactly one bracketed-paste packet containing that value; the later Return was
      a separate `0d` packet.
- [x] PASS — on 2026-08-28 the focused, visible terminal remained blink-off for 11 seconds with
      submitted frames `164 / 164`, draws `328 / 328`, uploaded bytes `11,299,200 / 11,299,200`,
      an empty scheduler trace, and no pending frame, timer, or link work. Blink-on produced four
      timer fires, four rAF requests/runs, and four submitted frames with at most one queued rAF;
      blink-off then returned to unchanged counters, an empty trace, and no pending work.
- [x] PASS — on 2026-08-28 the operator navigated the mirrored terminal rows and cursor with
      VoiceOver and confirmed that the spoken reading was correct. The operator clarified that
      the remaining leaf concern was visual rendering only, then disabled VoiceOver.

Operator result: **PASS**, recorded at `2026-08-28T12:42:24+03:00`. Every required physical
operator row above is recorded PASS.
