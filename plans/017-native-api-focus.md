# Plan 017: Drop the xterm facade, read history, and say what we are

Status: Approved, 2026-09-30. Not started. Supersedes Plan 016.

## Outcome

ghostty-webgpu is Ghostty for the web, with its own native API. It does not claim xterm.js
compatibility and does not ship an xterm-shaped facade. After this plan:

- The `ghostty-webgpu/xterm` and `ghostty-webgpu/xterm.css` exports, `src/xterm/`, the xterm parity
  ledger and every script and test that serves them are gone.
- The native `Terminal` can read any row as text, scrollback included, through the upstream
  libghostty-vt grid API.
- The README says plainly why this library exists, how it differs from ghostty-web, and when
  xterm.js is the better choice.

## Why

Full xterm.js parity needs a Ghostty fork and a large amount of emulation outside libghostty-vt, so
it was abandoned. The facade that remains is worse than no facade: `/xterm` has no automatic fit,
its buffer API throws, and link registration throws (`docs/replacement/README.md`). Nothing in
Fregat, the site or the demo imports it. The ledger shows 515 of 938 rows missing.

ghostty-web advertises "xterm.js API compatibility" and "migrate by changing your import", lists no
gaps, requires `await init()`, and builds Ghostty with a 1,620-line patch
(`patches/ghostty-wasm-api.patch`) that hand-writes a wasm API, `getScrollbackLine` included. This
library builds the pinned upstream revision without patches and uses the official C API. It should
say so, and should not repeat ghostty-web's unmeasured compatibility claim.

## 1. Delete the xterm facade

Delete, in one pass:

- `src/xterm/` (about 7,700 lines, tests included) and `src/xterm/css`.
- The `./xterm` and `./xterm.css` entries in `package.json` `exports`, and their build copies in
  `scripts/copy-build-assets.ts`.
- `docs/xterm-parity.md`, `docs/xterm-parity.json`, `scripts/xterm-parity.ts`,
  `scripts/xterm-reference.ts`, `scripts/xterm-browser-tests.ts`, `references/xterm-manifest.json`,
  `vitest.xterm-*.ts`, and the `xterm:*` and `test:xterm-browsers` scripts.
- `scripts/replacement/` and `docs/replacement/` (the ghostty-web comparison runs through `/xterm`),
  plus the `test:replacement` script and any CI job that calls a deleted script.
- The xterm entries in `scripts/package-smoke.ts`, `.oxfmtrc.json` and `THIRD_PARTY_NOTICES.md`
  (keep a notice only if shipped code still derives from xterm.js).

Then:

- `plans/README.md`: Plans 007–016 become historical, retired by this plan; this plan is the
  active milestone. The plan files stay as history.
- `AGENTS.md` Product Direction: the product is Ghostty for the web with a native API; Platform
  is one consumer. Remove the ghostty-web-replacement and xterm-ledger lines.
- `docs/integration.md`: native API only.
- **Versioning:** removing exports is breaking. The package is `0.1.2`; AGENTS.md lets agents change
  only the patch version, so the implementer asks the owner before release whether this ships as
  `0.2.0`. Record the answer in a changeset.

Acceptance: `bun run build`, core and browser tests, `test:package` and `test:package:host` pass;
`rg -i xterm src scripts package.json` finds nothing that is not deliberate (for example a comment
naming a behavior); Fregat's terminal feature builds and its terminal scenarios pass unchanged.

## 2. Read history as text

The native `Terminal` exposes only `visibleLines()`. Scrollback exists and renders, and
`src/core/selection.ts` already reads cells anywhere through `ghostty_terminal_grid_ref`, but there
is no public way to read history rows.

- **API**, shaped on the native `Terminal`, not on xterm:
  - `lineCount(): number`: scrollback rows plus visible rows on the active screen.
  - `readLines(start: number, end: number, options?): readonly TerminalLine[]`, rows `[start, end)`
    counted from the oldest scrollback row, where `TerminalLine` is
    `{ text: string; wrapped: boolean }`. `options.trimRight` (default `true`) drops trailing
    blanks.
  - Keep `visibleLines()` as is.
- **Implementation:** one core helper in `src/core/` that walks rows through `ghostty_terminal_grid_ref`
  and the existing grapheme and cell reads, shared by selection so there is one row reader, not two.
  Wide characters, grapheme clusters and soft wraps come out exactly as selection copies them.
- **Screens:** reads cover the active screen. If upstream offers no selector for the inactive screen
  (the primary screen while the alternate screen is up), document that limit in the API docs; do not
  patch Ghostty.
- **Bounds:** clamp to `lineCount()`, and cap one call's row count so a caller cannot build a huge
  string by accident. The cap is a named constant with its reason.
- **Tests (core, Node):** history after scrollback overflow, trimming, wide and combining characters,
  emoji ZWJ sequences, soft-wrapped rows, the alternate screen, clamping, and equality with what
  selection copies for the same range. Write the history test first and watch it fail.

## 3. Say what we are in the README

Replace the "inspired by ghostty-web" framing with three short sections, facts only, each one
checked against source before it is written:

- **Why this exists:** Ghostty's own terminal emulator (libghostty-vt, pinned upstream, unpatched)
  in the browser: the same parsing, Unicode and behavior as the Ghostty app, with a damage-aware
  renderer on WebGPU, then WebGL2, then Canvas2D.
- **Why not ghostty-web:** a few blunt bullets, each verified against the pinned ghostty-web 0.4.0
  source (`coder/ghostty-web@9e4e126d`):
  - it builds Ghostty from a 1,620-line fork patch instead of upstream's C API;
  - it claims xterm.js API compatibility and lists no gaps;
  - it needs `await init()` before a terminal exists;
  - its renderer: state exactly which backends it has (canvas only, if the source confirms it);
  - anything else measured on the same machine and fixture (damage-aware drawing, live themes,
    transparency, recovery from lost GPU contexts). No claim that was not measured.
- **Why not xterm.js:** honest. xterm.js is mature, has a large addon ecosystem, broader API and
  proven accessibility. Choose it when you need those. Choose this when you want Ghostty's
  emulator and rendering in the browser.

Keep the README's current voice (short, lowercase headings). No "rather than" or "instead of"
framing in the positioning copy.

## How to run it

One Sol worker (high) in its own worktree off Fregat main, one independent Sol reviewer (xhigh),
per the orchestrate skill. Parts 1 and 2 can be one PR or two; part 3 goes last so it describes the
shipped API. Heavy runs go through `/work/tmp/wave-heavy/run.sh`. The standalone
`ShaulLavo/ghostty-webgpu` repository updates through Fregat's mirror workflow; never push to it
directly.

## Done when

- The three parts are merged in Fregat, the mirror is updated, and the package builds and installs
  from a packed tarball.
- The history API has tests that failed before it existed.
- Every README comparison claim names its evidence (source path, or a measured run).
- The owner has answered the version question and the changeset records it.
