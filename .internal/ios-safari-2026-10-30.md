# iOS Safari triage, October 30, 2026

The frozen run used b3262bec. The investigated main, a322323b5, has the same tree as release e569a801 and does not fix the reported failures. This change fixes two product problems and the clear test assumptions. It does not qualify the full browser suite on iOS.

Safari retained an old resolved canvas font after a web font loaded. Resource invalidation now changes the font string before restoring the requested font. Saved viewport previews also drew before their canvas joined the document, causing Safari to choose a different generic font than the live terminal. They now attach before painting and remove the canvas if painting throws.

Tests keep exact pixels but use a named font or equally connected canvases. Byte comparisons avoid expensive deep inspection of million-byte arrays. Geometry checks allow CSS serialization precision or one physical pixel of layout rounding. Clipboard fixtures replace both platform and user agent. Worker selection checks its real adapter result and asserts fallback or capability rejection. No platform skip was added.

Native Safari 26.5 on iOS Simulator 26.5 build 23F77 passed 81 selected cases in 10 files at 402 by 714 CSS pixels and DPR 3. The other 290 registrations were filtered out. Chromium first passed 370 of 371 affected cases. The remaining font-assignment count was corrected, and the final three-file run passed all 48 cases. Typechecking, lint, formatting and the build passed.

## Original failure accounting

The case ledger is `/work/reports/wave-20261029/agent-tools/ios-live/ghostty-triage-evidence/triage-cases.tsv`. Regenerate it with the adjacent `triage.py`.

| Original failed rows | Disposition                                                             |
| -------------------: | ----------------------------------------------------------------------- |
|                    3 | Product defects fixed: late font refresh and two viewport preview cases |
|                   32 | Test assumptions fixed, including ten worker-selection capability cases |
|                  180 | WebGPU preconditions unavailable                                        |
|                   20 | Explicit desktop viewport requests unavailable                          |
|                  146 | Original flagged provider operations, untouched                         |
|                    1 | Module interception rejected by the provider, untouched                 |
|                    7 | FontFaceSet notification follow-up                                      |
|                    5 | Native interaction follow-up                                            |

The 348 setup-hook cases remain unqualified: 102 require WebGPU and 246 require unavailable native viewport sizes. Both Window and DedicatedWorker expose `navigator.gpu`, but `requestAdapter()` returns null. The secure context is true. Automatic WebGL2 fallback is correct. Native capabilities report `setWindowRect: false`.

## Follow-up work

Status: Approved.

- `src/dom/tests/font-resource-generation.browser.test.ts` still fails seven non-WebGPU variants at `expect(fontEvents).toBeGreaterThan(0)`. The original run and a current-source native rerun both observed zero `loadingdone` events. Investigate Safari's cached FontFaceSet load behavior before changing automatic resource refresh in `src/dom/terminal.ts`, which subscribes to those events. The explicit invalidation regression now passes. The original WebGPU variants remain unavailable.
- `src/render/dom/renderer.browser.test.ts`, case `keeps real focus, drag selection, wheel, and mouse reporting under forced DOM fallback`, returns body as the active element after the provider click. The two real clipboard cases in `src/dom/tests/selection-packaged.browser.test.ts` never set the click callback's baseline promise. The two trusted clipboard cases in `src/dom/tests/selection-history.browser.test.ts` wait for callbacks. Qualify the native adapter's click, iframe coordinates and user activation before assigning these five failures to the product. Do not infer absence of clipboard support from them.
- The native-only GPU suites and large viewport suites need a suitable device or separately designed compact fixtures. Do not replace explicit WebGPU tests with WebGL or count failed hooks as passing tests.

The retained controller, exact selections, candidate diff, native identities, per-case results and actual-host cleanup receipts are in the evidence directory above. Original run receipts are untouched. Every new native session and driver was deleted, task tunnels stopped, scratch removed, and the Mac lock released. The track-owned simulator remains under its existing cleanup owner.
