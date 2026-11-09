# Complete non-GPU browser suite preparation

Status: Approved. The parent owns independent review, hosted CI, merge and native execution.

Starting main: `9cd0226f3d0fd085af4df893a048fa97b24137c5`.

| Stage               | Complete unchanged original                          | Cases |
| ------------------- | ---------------------------------------------------- | ----- |
| `legacy-text`       | `bench/comparison-legacy-text.browser.test.ts`       | 2     |
| `pointer-selection` | `src/dom/tests/pointer-selection.browser.test.ts`    | 14    |
| `hotkeys-focus`     | `src/extensions/hotkeys/tests/focus.browser.test.ts` | 21    |

Eligibility was checked against the actual source before edits. Legacy text uses
Canvas2D in pinned ghostty-web. Pointer selection dispatches synthetic events on a
plain canvas and retains its original FakeSelectionClock. Hotkey focus imports
built dist and explicitly uses DomTerminalRenderer. Its keys, composition and
paste events are synthetic. Neither screenshot needs a new adapter or file root.
No original has a per-case timeout override or provider input command.

This registration gives no native completion credit. The canonical count stays 25. Frozen failed files and all fixed 35 parked plus 16 inapplicable case rows
remain untouched. No source tests, adapters, dependencies, versions or wasm change.

## Source identities

- Legacy text: Git blob `53e50703f0a4ae8662d21883d3f2d55e5925c352`, SHA-256 `3335534124bd8eb476e9e66c6e93028d31a33532354c009c5a54dbec10cdcf70`.
- Pointer selection: Git blob `4e5190c10aedfac1b1adc81a3b069210ae890835`, SHA-256 `d1504dac38906a9dbe6d0326ed390350ed94aa4201a381ec20a5c8f464b65b6e`.
- Hotkey focus: Git blob `1c0d878210d401c017696aa1ce632ced80ddea2d`, SHA-256 `a589db2abdb54e8553ccf9afba7e7601faef7e0bd8149599afcf10f790141674`.

The manifests bind every expanded title, source key, 15,000 ms case clock and
zero retry count. Native hook clocks remain 30,000 ms. The existing source
inventory checker now expands the outer `describe.each` in hotkey focus.
Shared `resultFixture` and `receiptFixture` records test every omitted case and
reject malformed, failed, skipped, retried or substituted results.

The PR 123 screenshot test also evaluates both new originals' option expressions
and reaches the installed official WebdriverIO permission checks and callback.
The legacy screenshot keeps its element and omitted scale and save options.
Hotkey focus keeps its terminal element, `scale: 'css'` and omitted save option.
Both paths resolve inside root `.artifacts`. The CPU test stops at browser lookup,
so it does not claim native pixels or native CSS-scale behavior.

## Reproduce

Use the installed heavy runner with `--host local` around these commands:

```sh
bun run build
bun run verify:extensions
bun run typecheck && bun run lint && bun run format:check
bun run test:unit
node node_modules/vitest/vitest.mjs run scripts/ios-browser-nongpu.test.ts scripts/ios-browser-source.test.ts scripts/ios-browser-canvas-scroll.test.ts
bun run --cwd site docs:check
bun run test:browser bench/comparison-legacy-text.browser.test.ts src/dom/tests/pointer-selection.browser.test.ts src/extensions/hotkeys/tests/focus.browser.test.ts
```

The three initial registration checks failed before implementation. The full
unit command passed with 1,992 Vitest cases, one pre-existing skipped case, 485
comparison tests, four checkpoint tests and two codec tests. Addon checks passed
124 tests and both package smoke checks. The final focused command passed 24
tests. Typecheck, lint, formatting and docs checks passed. Existing lint warnings
remain outside this change.

The unchanged desktop originals passed all 37 cases in Chromium after the build.
An initial run passed the 35 pointer and hotkey cases but failed to import legacy
text when the owned dependency directory was symlinked from `/work`. Moving that
same install into the exclusive checkout fixed the import without source or
file-root changes. No physical display, DPR, viewport or backend override was used.
This is desktop correctness only, not native completion.

Command logs and the final head are in
`/work/reports/goals/ghostty-iphone-eligibility/batch-nongpu/HANDOFF.md`.
