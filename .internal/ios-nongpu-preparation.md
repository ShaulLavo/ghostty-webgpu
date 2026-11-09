# Complete non-GPU browser suite preparation

Status: Approved. The parent owns independent review, hosted CI, merge and native execution.

Starting main: `9cd0226f3d0fd085af4df893a048fa97b24137c5`.

| Stage | Complete unchanged original | Cases |
| --- | --- | --- |
| `legacy-text` | `bench/comparison-legacy-text.browser.test.ts` | 2 |
| `pointer-selection` | `src/dom/tests/pointer-selection.browser.test.ts` | 14 |
| `hotkeys-focus` | `src/extensions/hotkeys/tests/focus.browser.test.ts` | 21 |

Eligibility was checked against the actual source before edits. Legacy text uses
Canvas2D in pinned ghostty-web. Pointer selection dispatches synthetic events on a
plain canvas and retains its original FakeSelectionClock. Hotkey focus imports
built dist and explicitly uses DomTerminalRenderer. Its keys, composition and
paste events are synthetic. Neither screenshot needs a new adapter or file root.
No original has a per-case timeout override or provider input command.

This registration gives no native completion credit. The canonical count stays
25. Frozen failed files and all fixed 35 parked plus 16 inapplicable case rows
remain untouched. No source tests, adapters, dependencies, versions or wasm change.

Local commands, exact source identities and results will be recorded here and in
`/work/reports/goals/ghostty-iphone-eligibility/batch-nongpu/HANDOFF.md`.
