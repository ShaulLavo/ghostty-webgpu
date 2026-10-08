# Terminal correctness

This comparison checks terminal state, response bytes and Unicode delivery in headless Chromium. It runs 132 test methods from a pinned esctest2 checkout and 37 local cases against three web terminals. The results apply to this selection and these configurations.

## Results

Each cell below is **pass / fail**. The complete run contains 507 terminal/case pairs. A second complete run on the same machine, using a fresh automatic upstream clone, reproduced all 507 outcomes and the recorded asset hashes, including the ghostty-web page crash. A further run with fatal setup checks reproduced the same outcomes and asset hashes after passing all setup regression controls.

| Selection   | ghostty-webgpu | xterm.js | ghostty-web |
| ----------- | -------------: | -------: | ----------: |
| esctest2    |        130 / 2 |  97 / 35 |     126 / 6 |
| Local cases |         37 / 0 |   29 / 8 |      35 / 2 |
| Total       |        167 / 2 | 126 / 43 |     161 / 8 |

The measured result is that ghostty-webgpu passes more cases in this fixed selection than the two pinned alternatives in their tested configurations. Two upstream expectations still fail in our terminal. This comparison supports that limited statement; full VT conformance, native Ghostty parity and renderer correctness remain open.

### Per suite

| Suite          | ghostty-webgpu | xterm.js | ghostty-web |
| -------------- | -------------: | -------: | ----------: |
| cuu            |          5 / 0 |    5 / 0 |       5 / 0 |
| cud            |          5 / 0 |    5 / 0 |       5 / 0 |
| cuf            |          5 / 0 |    4 / 1 |       5 / 0 |
| cup            |          6 / 0 |    5 / 1 |       6 / 0 |
| cha            |          5 / 1 |    5 / 1 |       5 / 1 |
| cnl            |          5 / 0 |    3 / 2 |       5 / 0 |
| cpl            |          5 / 0 |    3 / 2 |       5 / 0 |
| ed             |         10 / 0 |    9 / 1 |      10 / 0 |
| el             |          7 / 0 |    6 / 1 |       7 / 0 |
| ech            |          6 / 0 |    5 / 1 |       6 / 0 |
| ich            |          6 / 0 |    4 / 2 |       6 / 0 |
| dch            |          6 / 0 |    3 / 3 |       5 / 1 |
| il             |          6 / 0 |    4 / 2 |       6 / 0 |
| dl             |         10 / 0 |    6 / 4 |       9 / 1 |
| tbc            |          3 / 1 |    4 / 0 |       2 / 2 |
| cht            |          3 / 0 |    2 / 1 |       3 / 0 |
| cbt            |          4 / 0 |    4 / 0 |       4 / 0 |
| su             |          9 / 0 |    5 / 4 |       9 / 0 |
| sd             |          9 / 0 |    5 / 4 |       9 / 0 |
| rep            |          4 / 0 |    3 / 1 |       3 / 1 |
| cr             |          5 / 0 |    2 / 3 |       5 / 0 |
| lf             |          6 / 0 |    5 / 1 |       6 / 0 |
| unicode-text   |         16 / 0 |   14 / 2 |      16 / 0 |
| grapheme-width |         16 / 0 |   10 / 6 |      16 / 0 |
| delivery       |          2 / 0 |    2 / 0 |       1 / 1 |
| reports        |          2 / 0 |    2 / 0 |       2 / 0 |
| unicode-burst  |          1 / 0 |    1 / 0 |       0 / 1 |

[All individual results and failure details](https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/correctness-results.json) include the exact emitted input hex for every upstream case, assertion messages, and available screen text, cursor coordinates and replies for failures.

### Findings

Both ghostty-webgpu failures below are inherited from the pinned upstream core and reproduced in unpatched libghostty-vt and native Ghostty 1.3.1-arch2. [The independent probes](https://github.com/ShaulLavo/fregat/pull/964#issuecomment-6054698739) also reproduce them through the checked-in WASM with no bridge. Both remain counted as failures. This establishes agreement for these two cases; general native Ghostty parity and full VT conformance remain open.

- ghostty-webgpu fails `test_CHA_RespectsOriginMode`. esctest2 expects `X` at column 5, row 6; the observed `X` is at column 5, row 11. ghostty-web shows the same row displacement. xterm.js also fails this test, with a different position. The disagreement with this upstream expectation stays in the totals.
- ghostty-webgpu fails `test_TBC_Default`. After clearing the tab stop with `CSI g`, the next tab still reaches column 9; esctest2 expects column 17. The explicit `CSI 0 g` control passes. ghostty-web also fails the default-parameter case. xterm.js passes it.
- xterm.js loses U+200D in both one-byte ZWJ cases. `👩‍💻` becomes `👩💻`, and `👨‍👩‍👧‍👦` becomes `👨👩👧👦`. Whole-buffer writes retain these code points. Both Ghostty wrappers retain them with either delivery pattern.
- xterm.js has six width disagreements with the stated emoji expectations. Its default Unicode provider was used. These are distinct from the two text-retention failures and say nothing about its optional Unicode providers.
- ghostty-web throws `RangeError: offset is out of bounds` for an empty byte write. Its page also crashes in the 40-by-12 Unicode burst case, reported by Playwright as `Target crashed`. The earlier benchmark described a WASM `memory access out of bounds` exception. This run reproduces a Unicode-related page failure, with a different observed failure signature. Its cause is unconfirmed. The same burst completes in ghostty-webgpu and xterm.js.
- ghostty-web also disagrees with DCH, DL, tab and REP expectations. The JSON retains those failures, including extra cell text after delete operations. Left/right margins and ISO-protected erasure account for many of xterm.js's VT disagreements. Unsupported features count as failures in this fixed selection.

## Versions and method

Run date: 2026-10-08. Machine: Intel Core i7-14700K, Arch Linux, kernel 7.2.8-arch1-2. Browser: headless Chromium 153.0.8010.12 through Playwright 1.63.0.

| Terminal       | Version | Configuration                                                         |
| -------------- | ------- | --------------------------------------------------------------------- |
| ghostty-webgpu | 0.3.20  | Checkout core and checked-in WASM, native state snapshots             |
| xterm.js       | 6.0.0   | `@xterm/xterm`, default Unicode provider, default renderer, no addons |
| ghostty-web    | 0.4.0   | Coder's npm package, public terminal with its canvas renderer         |

The terminal source is unchanged from Fregat commit `523ccf51c459dee0424cfb7829fd527f033b9a5a`. Its WASM provenance names official Ghostty revision `7b11f3dca034d8d24369ad3856afe57946d7902a`. The checked-in result records WASM hashes, the bundled browser adapter hash and the Python adapter hash.

The runner clones [esctest2](https://github.com/ThomasDickey/esctest2/tree/2798f12149a19c3295e9b4853ab2da4b2eff1b2b) at `2798f12149a19c3295e9b4853ab2da4b2eff1b2b` into a temporary directory. It executes the original Python test methods. Upstream source remains a runtime dependency and retains its upstream license.

The transport adapter sends the original escape sequences as UTF-8 bytes over a JSON-line connection to the browser driver. xterm.js and ghostty-web writes finish through their write callbacks. ghostty-webgpu writes finish synchronously. Cursor assertions use esctest2's original DSR request and the terminal's actual reply, collected through `onData` or the native `writePty` effect. This keeps origin-relative cursor reports intact. The known 80-column, 24-row fixture supplies `GetScreenSize`.

Rectangle assertions read cells from each terminal's state. The native driver uses render-state snapshots, xterm.js uses buffer cells, and ghostty-web uses its WASM render-state cells and grapheme reader. These readers include grapheme tails. Empty cells compare as spaces; wide-character continuation cells contribute an empty string. The rectangle tests use ASCII, so column positions stay unambiguous.

Each upstream test gets a new terminal handle. Each upstream suite gets a fresh document. Each local case gets a fresh browser context. Only the selected terminal's WASM runtime loads in that document. Every terminal first passes an ASCII text and cursor control; deliberately wrong text and cursor expectations must fail. The runner also checks that each terminal produces the same 169 unique case results.

Navigation, adapter readiness and terminal creation failures abort the run with an error naming the terminal and setup step. Only failures after setup enter the terminal case results. Regression controls use a failed navigation, a page with no adapter and an adapter that rejects terminal reset. Each must reject before the case body runs and leave the result count unchanged. A separate upstream control requires a broken reset to abort the Python/browser run without case results.

The esctest2 profile sets VT level 5, checksum convention 334 and a neutral terminal name. Known-bug decorators remain strict. Unsupported commands in the selected tests count as failures; they receive no capability-based exemption.

## Local cases

Eight strings cover CJK, combining accents, a standalone emoji, a skin-tone modifier, a ZWJ emoji, a family emoji, a regional-indicator flag and VS16. Each runs as one complete byte write and as one byte per write. Separate assertions check exact code-point retention and cursor width. Mode 2027 is requested on each terminal. The width expectations are ten columns for `日本語中文`, one for `é`, and two for each emoji cluster.

The remaining cases check a CSI sequence delivered one byte at a time, an empty byte write, DSR status and position replies, and a Unicode burst. The burst reuses the comparison benchmark's Unicode fixture and its 4 KiB corpus construction, with 32 writes at 40 columns and 12 rows. Two animation frames settle each write. It checks retained CJK and emoji text and catches renderer errors. The xterm.js and ghostty-web renderers are active during these waits; the ghostty-webgpu driver reads native state without attaching a renderer.

This tests xterm.js's default configuration. Its Unicode addons and other providers are separate configurations. The width results describe agreement with the stated modern-grapheme expectations; the text-retention checks independently detect dropped code points.

## Exclusions

- Original DECRQCRA checksum replies. Rectangle assertions use state reads, with empty cells and spaces treated alike. Checksum arithmetic, cell attributes and the distinction between an erased cell and a written space remain outside the comparison.
- Window-size reports. The fixture size is supplied directly. DSR cursor and status replies are exercised end to end.
- esctest2 suites outside the 22 listed above. This selection covers cursor movement, editing, erasing, margins, tabs, scrolling, repeat, carriage return and line feed. It leaves device attributes, colour queries, clipboard and selection operations, titles, window operations, advanced rectangular operations and other terminal profiles for later work.
- Raw 8-bit C1 input, malformed UTF-8, input encoding, keyboard and mouse protocols, resize/reflow and long-running history eviction. The byte-delivery cases use valid UTF-8 and 7-bit escape sequences.
- Pixel comparisons, fonts, emoji colour, GPU behaviour and comparisons with the native Ghostty app. Renderer-specific correctness needs its own image tests. These results establish a bounded state comparison.

## Reproduce

From a fresh Fregat checkout with the documented Bun prerequisite, Git and Python 3:

```sh
bun install --frozen-lockfile
cd ghostty-webgpu
bunx playwright install chromium
bun scripts/correctness.ts
```

The default output is `.artifacts/correctness/results.json`. To choose an output directory and reuse an existing, unmodified upstream checkout at the pinned commit:

```sh
bun scripts/correctness.ts /path/to/results /path/to/esctest2
```

The runner uses an OS-assigned free port on `127.0.0.1`. It closes Chromium, stops its HTTP server and removes its temporary build and upstream checkout afterwards. A supplied checkout is retained. `TMPDIR` and `PLAYWRIGHT_BROWSERS_PATH` can choose temporary and browser-cache locations.

Exit status zero means the comparison completed and its calibration, version pins and case inventory checks passed. Terminal assertion failures remain in the results. A runner, build, calibration or inventory failure exits with an error.

Source: [runner](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/scripts/correctness.ts), [browser drivers](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/scripts/correctness-browser.ts), [esctest2 adapter](https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/scripts/correctness-esctest.py).
