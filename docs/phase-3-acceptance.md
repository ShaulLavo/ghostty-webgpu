# Phase 3 acceptance

Status: **PENDING — physical operator gate deferred on 2026-08-23.**

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

All items remain **PENDING**.

- [ ] Hold and release a printable key in `demo/kitty-keyboard-check.py`; record Kitty repeat
      (`:2`) and release (`:3`) packets.
- [ ] Exercise physical Shift, Ctrl, Option, and Command modifiers, arrows, and a function key.
- [ ] Confirm macOS-intercepted Command-Tab and Command-Space produce no PTY byte packet.
- [ ] Add/switch to a CJK input source and commit `你好` once. Expected UTF-8 bytes:
      `e4 bd a0 e5 a5 bd`, with no ASCII preedit bytes.
- [ ] Insert `🧪` once through Character Viewer. Expected UTF-8 bytes: `f0 9f a7 aa`.
- [ ] Under the ABC input source, press Option-N then `a` and commit `ã` once. Expected UTF-8
      bytes: `c3 a3`.
- [ ] Copy a known native terminal selection with physical Command-C, paste it with physical
      Command-V, and confirm exact single insertion.
- [ ] Navigate the mirrored terminal rows and cursor with VoiceOver; confirm spoken order and
      content, then disable VoiceOver.

After those checks pass, add the operator result and timestamp here, change this status to PASS,
then update the platform Phase 3 brief and plan index. Until then, platform completion status must
remain unchanged.
