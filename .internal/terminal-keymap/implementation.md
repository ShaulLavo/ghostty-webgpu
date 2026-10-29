# Terminal keymap implementation

Status: Approved

The approved design is `/work/reports/wave-20261029/terminal-design-split.md`, decisions 1–6.

- Read the Principles section in full. Done.
- `how` over the affected subsystem. Original DOM keys reach `connectInput` before the core encoder. The adapter creates a focus node and sends claimed text through `sendGeneratedInput`. Native modes come from the synchronous terminal.
- `architect` skipped. The approved design already specifies the module and API shape.
- Blocking first steps. Read guidance, copy dependencies into task-owned scratch, build baseline and run focused tests.
- Independent workstreams. This implementation owns B1–B6 only. The coordinator owns alternate-screen wheel work and release integration.
- Shared mutable state. Use the prepared worktree. Do not modify the main checkout. Dependencies are a task-owned copy.
- Smallest safe decomposition. One implementation owner because package exports, input removal and keymap tests must change together.
- Data shape. `ghosttyKeymap` is platform-indexed binding data. Screen-reader mode is a context value. Commands operate on the synchronous terminal API.
- Model the Domain keeps the five text shortcuts in binding data instead of core conditionals.
- Subtract Before You Add removes the core bindings and root exports before extending the add-on.
- Prove It Works requires browser input/output checks and packed-consumer import checks.

Initial task resources were absent `node_modules`, `dist`, and task scratch. This run owns `/work/tmp/ghostty-terminal-b-2c3d7732`, its dependency copy, the worktree `node_modules` symlink, generated build output and test artifacts. Existing global caches, services and other runner jobs are preserved. The test runner owns browser/server teardown. Remove task scratch and generated artifacts after verification, retaining this receipt.

Source-proven adjustment: `src/dom/input.ts` also imports hotkeys for platform detection and copy matching. Replace those uses locally so the main entry graph can actually be free of hotkeys.

Additional source-proven adjustments:

- Remove the default paste binding and let Ctrl+Shift+V reach the browser paste event on Linux and Windows. Core suppresses that physical key's encoder path, just as it already does for Ctrl+V and Cmd+V.
- Migrate the demo and classic-site imports, the site bundler alias, and both site TypeScript path maps with the main-entry export removal.

Verification on the PC used the shared heavy runner. Baseline was built before edits.

| Command                                                                                                                                                                                                                                         | Result                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run build`                                                                                                                                                                                                                                 | Passed before edits and after implementation.                                                                                                                                                    |
| `bunx vitest run src/extensions`                                                                                                                                                                                                                | Baseline 68 passed, 1 skipped. Final 72 passed, 1 skipped.                                                                                                                                       |
| `bun scripts/browser-tests.ts src/extensions/hotkeys/tests src/dom/tests/mac-keybindings.browser.test.ts`                                                                                                                                       | Baseline 29 passed.                                                                                                                                                                              |
| `bun run typecheck`                                                                                                                                                                                                                             | Passed.                                                                                                                                                                                          |
| `bun run lint`                                                                                                                                                                                                                                  | Passed with existing repository warnings.                                                                                                                                                        |
| `bun scripts/browser-tests.ts src/extensions/hotkeys/tests src/dom/tests/mac-keybindings.browser.test.ts src/dom/tests/terminal-input.browser.test.ts src/dom/tests/pointer-selection.browser.test.ts src/dom/tests/extensions.browser.test.ts` | 134 passed in Chromium. SwiftShader proves correctness, not performance.                                                                                                                         |
| `TMPDIR=/work/tmp/ghostty-terminal-b-2c3d7732 bun run test:package`                                                                                                                                                                             | Passed. Packed subpath resolves; optional peer metadata and main module graph isolation checked; TypeScript 7 Bundler, TypeScript 5 Bundler and Node10 passed; browser WASM/Canvas smoke passed. |
| `bun run --cwd site docs:check`                                                                                                                                                                                                                 | Passed. 17 authored pages, examples compile, 7 tests passed.                                                                                                                                     |
| `bun run --cwd demo typecheck`                                                                                                                                                                                                                  | Passed.                                                                                                                                                                                          |
| `bun run --cwd site typecheck`                                                                                                                                                                                                                  | Passed.                                                                                                                                                                                          |
| `bun run format:check`                                                                                                                                                                                                                          | Passed.                                                                                                                                                                                          |
| `git diff --check`                                                                                                                                                                                                                              | Passed.                                                                                                                                                                                          |

A direct Node import of `dist/index.js` also passed with the task-owned `node_modules/@fregat/hotkeys` link temporarily absent. The link was restored in `finally`.

The first implementation browser run found two fixture mistakes, a Mac add-on fixture whose core still detected Linux and an alternate-screen selection assertion that needed to invoke clear rather than native input. Both were corrected. The docs check exposed a separate examples path map and missing workspace dependency links. Both were corrected before the final passing check.

The author checkout remains available for coordinator review and CI fixes. Its task-owned dependency copy is 679 MiB at `/work/tmp/ghostty-terminal-b-2c3d7732`; its current consumer is this open PR's author checkout. The coordinator owns removing that directory and task-created dependency links after merge and fixes finish. Disposable package-smoke consumers removed themselves. Browser test processes and servers exited. App-owned MCP and language-server processes are preserved.

Independent review found one shared issue. Both Sol reviewers traced Cmd+K reading mode/cursor before `write()` flushed queued output. A browser regression reproduced the prompt remaining on row one. Clear now uses `writeAndReadGeometry('')` to flush first and then checks the active screen. Added queued cursor-movement and alternate-screen-entry cases. Comment Sicko reported no findings; no comments, suppressions, constraints, or application code were changed for that review. Fix Root Causes selected the existing flush/read operation instead of a second cached cursor read.

The focused follow-up Sol review reported no findings. The final rerun passed all 134 browser cases, 72 unit tests, packed-consumer smoke, static checks, and docs checks. No review objections remain.
