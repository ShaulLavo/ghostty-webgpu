# Complete Canvas scroll preparation

Status: Approved. The parent owns independent review, CI acceptance, merge and any later native run.

The `canvas-scroll` stage selects the complete unchanged
`src/render/canvas/scroll.browser.test.ts`. All 15 expanded cases remain required.
The original has 23,192 bytes and 609 lines. Its Git blob is
`c8e25894fb5311706fa18f96f98229e059b9f88c`, and its SHA-256 is
`7e84e87bfea3408774a4caaa517dda7e80e1dd53dec5954803ff55e01e2769c0`.
The starting main is `343f06ac2ed5e7c1b518c30a32155066d0acf4e5`, containing PR 108.
The public Waffle dependency remains 0.0.114. No package version changes.

The existing stage, manifest and full-source-hash gates bind all original tables,
assertions, hooks, frame clocks, loops and cleanup. The generic source inventory
checker now accepts literal boolean parameters and checks this manifest too.
Native case clocks remain 15,000 ms, hooks 30,000 ms and retries zero.
There is no explicit viewport operation, exclusion or reduced suite.

Three source sites require four successful saved candidate-canvas captures.
The boolean table expands line 243 into ASCII and Unicode captures. Lines 515
and 538 save styled and native pixel frames. All retain the real `f.canvas`,
the exact authored paths and omitted `save` and `scale` options. Runtime glyph
counts remain runtime values, not numbers prescribed by the manifest.

The official screenshot wrapper defaults `save` to true. Its WebDriverIO callback
resolves each custom path relative to the original test file, checks API write
permissions and Vite file roots, creates the directory and calls the element's
`saveScreenshot`. All paths resolve inside repository-root `.artifacts` under
existing permissions. No file-root, adapter or configuration change is needed.
The PR 108 bound adapter and its existing combined controls remain unchanged.

The new CI-discovered test invokes the installed official wrapper and provider
callback for all four original option expressions. It deliberately throws at
the browser getter after permission checks and directory creation. It starts
no browser and produces no pixels. The values 7 and 42 are expression-evaluation
fixtures only, not measured glyph counts. Existing combined controls separately
exercise the bound adapter and synthetic capture transport in normal CI.

Preparation, unit fixtures and desktop synthetic controls do not establish
original execution or native completion. Native Safari pixels, crop, DPR,
actual command arrival and whole-file native success remain unmeasured.
Reports and command logs are retained at
`/work/reports/wave-20261109/ghostty-canvas-scroll-screenshot/`.

Local checks passed on the PC through the heavy runner. They cover the full
normal unit command, root build, both addon builds and package checks, typecheck,
lint, formatting and the site docs checker. The focused source and permission
checks pass all 13 tests. Local package smoke and renderer-browser commands
are intentionally outside this preparation. The parent owns hosted CI.

## Existing desktop-control timeout

One final full unit run passed all new Canvas scroll checks but timed out in
`scripts/ios-browser-controls.test.ts` for `desktop observation double preserves
normal import-fault lifecycle`. Its unchanged line 40 sends SIGKILL at 45 seconds;
line 42 then reports `'SIGKILL' !== null`. The preceding full unit command passed.
A bounded rerun of the whole 16-control file passed all 16 in 12.93 seconds.
Neither control source nor clocks changed. No native or original file was run.

Reproduce with `bun run test:unit`, or run the full control file with
`node node_modules/vitest/vitest.mjs run scripts/ios-browser-controls.test.ts`.
Both ran through the PC heavy runner. Logs are `unit-final.log` and
`control-recheck.log` in the report directory above. The failure occurred once
in two full runs. Its root cause is unconfirmed; do not increase clocks or
remove the test. If it recurs in hosted CI, inspect the child browser/Vite import
and reporting path in `scripts/fixtures/ios-browser/desktop-control.ts` before
expanding this bounded registration task.
