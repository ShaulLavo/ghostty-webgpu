# Plan 017: Drop the xterm facade, read history, measure, and say what we are

Status: Approved, 2026-09-30. Not started. Supersedes Plan 016.

## Outcome

ghostty-webgpu is Ghostty for the web, with its own native API. It does not claim xterm.js
compatibility and does not ship an xterm-shaped facade. After this plan:

- The `ghostty-webgpu/xterm` and `ghostty-webgpu/xterm.css` exports, `src/xterm/`, the xterm parity
  ledger and every script and test that serves them are gone.
- The native `Terminal` can read any row as text, scrollback included, through the upstream
  libghostty-vt grid API.
- Published benchmarks compare it with xterm.js and ghostty-web on the same machine.
- The README makes the case for Ghostty in the browser with those numbers, says how it differs
  from ghostty-web, and says when xterm.js is the better choice.

Breaking changes are wanted. This is greenfield: remove and reshape the API freely, bump the
version to match, and add no deprecations, aliases or shims.

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
- `docs/integration.md`: native API only.
- Bump the version for the removed exports (`0.1.2` → `0.2.0`) with a changeset. `AGENTS.md`
  already points at this plan and welcomes breaking changes.

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

## 3. Benchmarks

Measure what Ghostty in the browser buys, against `@xterm/xterm` (current release, WebGL renderer
addon, and its default DOM renderer) and ghostty-web (pinned 0.4.0), on the same machine, fixtures,
font, size and DPR. Headed Chromium on a hardware adapter (AGENTS.md: SwiftShader proves
correctness only); add Firefox and Safari where each library runs there.

| Measure                 | What it shows                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parse throughput (MB/s) | libghostty-vt's SIMD parser against xterm.js's JS parser, with rendering paused or off-screen, over corpora: plain ASCII, dense SGR color, Unicode and emoji ZWJ, cursor-motion heavy (TUI redraw), and a large `cat` of real logs |
| Write-to-frame latency  | time from `write` to the frame that shows it, p50/p95                                                                                                                                                                              |
| Burst frame time        | frame time and dropped frames while streaming the corpora                                                                                                                                                                          |
| Input latency           | key event to echoed glyph on screen, through a local echo fixture                                                                                                                                                                  |
| Memory                  | per terminal, and per 10,000 scrollback rows                                                                                                                                                                                       |
| Many terminals          | 1, 8 and 17 terminals open, CPU and memory while idle and under output                                                                                                                                                             |
| Correctness spot checks | the same Unicode and escape-sequence fixtures rendered by all three, screenshots compared by eye and recorded                                                                                                                      |

- Byte streaming is part of the story: this library takes `Uint8Array` straight from the PTY into
  wasm, with no decode into JS strings on the way. Measure the string path of the other two
  alongside their byte path where they have one.
- Reuse `bench/` and `bun run bench:renderer`. Write the new runner as `bun run bench:compare`, with
  JSON artifacts that record commit, browser, GPU, OS, font, DPR and fixture hashes, and a
  `docs/benchmarks.md` that reports medians over repeated, order-alternated runs.
- Report losses as plainly as wins. A number that was not measured does not appear in the README.

## 4. Say what we are in the README

Replace the "inspired by ghostty-web" framing with short sections, facts only, each checked against
source or a benchmark artifact before it is written:

- **Why Ghostty:** Ghostty is one of the best terminal emulators, and this is its emulator core,
  libghostty-vt, pinned upstream and unpatched, running in the browser. Say concretely what that
  buys, with sources:
  - a SIMD-optimized parser, strong Unicode and grapheme handling, optimized memory use, and a
    fuzzed, Valgrind-tested core (libghostty's own claims; link
    [Mitchell Hashimoto's libghostty post](https://mitchellh.com/writing/libghostty-is-coming));
  - the same parsing and behavior as the Ghostty app, including modern protocols it parses;
  - bytes in from the PTY, no JS string decoding;
  - the benchmark results from part 3;
  - the xterm.js team itself is exploring libghostty because its JS parser has hit hard limits
    ([xterm.js #5686](https://github.com/xtermjs/xterm.js/issues/5686)).
- **Renderer:** damage-aware drawing on WebGPU, then WebGL2, then Canvas2D, with live themes and
  recovery from lost GPU contexts.
- **Why not ghostty-web:** a few blunt bullets, each verified against the pinned ghostty-web 0.4.0
  source (`coder/ghostty-web@9e4e126d`) or our own run:
  - it builds Ghostty from a 1,620-line fork patch (`patches/ghostty-wasm-api.patch`) that
    hand-writes a wasm API, where this library uses upstream's C API;
  - it claims xterm.js API compatibility and lists no gaps;
  - it needs `await init()` before a terminal exists;
  - its renderer backends, stated exactly (canvas only, if the source confirms it);
  - reported crashes: a WASM memory corruption where `free()` after an emoji breaks every
    terminal opened afterwards ([AkaraChen/2code #145](https://github.com/AkaraChen/2code/issues/145));
    include it only if it reproduces on 0.4.0;
  - the part 3 numbers.
- **Why not xterm.js:** honest. xterm.js is mature, with a large addon ecosystem, a broader API and
  proven accessibility. Choose it when you need those; choose this when you want Ghostty's
  emulator, byte streaming and the part 3 numbers.

Keep the README's current voice (short, lowercase headings). No "rather than" or "instead of"
framing in the positioning copy.

## How to run it

One Sol worker (high) in its own worktree off Fregat main, one independent Sol reviewer (xhigh),
per the orchestrate skill. Parts 1 and 2 can be one PR or two; part 3 is its own PR; part 4 goes last
so it describes the shipped API and cites the part 3 artifacts. Benchmark runs are CPU- and
GPU-sensitive: run them when no other heavy work is on the machine, and never alongside a Fregat
input-latency calibration. Heavy runs go through `/work/tmp/wave-heavy/run.sh`. The standalone
`ShaulLavo/ghostty-webgpu` repository updates through Fregat's mirror workflow; never push to it
directly.

## Done when

- The four parts are merged in Fregat, the mirror is updated, and the package builds and installs
  from a packed tarball.
- The history API has tests that failed before it existed.
- `docs/benchmarks.md` and its JSON artifacts are published, losses included.
- Every README claim names its evidence (source path, link, or a benchmark artifact).
