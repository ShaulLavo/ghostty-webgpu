# iOS Safari triage, October 30, 2026

The current strict composited-capture disposition is recorded in the final section below.

The frozen run used b3262bec. The investigated main, a322323b5, has the same tree as release e569a801 and does not fix the reported failures. This change fixes two product problems and the clear test assumptions. It does not qualify the full browser suite on iOS.

Safari retained an old resolved canvas font after a web font loaded. Resource invalidation now changes the font string before restoring the requested font. Saved viewport previews also drew before their canvas joined the document, causing Safari to choose a different generic font than the live terminal. They now attach before painting and remove the canvas if painting throws.

Tests keep exact pixels but use a named font or equally connected canvases. Byte comparisons avoid expensive deep inspection of million-byte arrays. Geometry checks allow CSS serialization precision or one physical pixel of layout rounding. Clipboard fixtures replace both platform and user agent. Worker selection checks its real adapter result and asserts fallback or capability rejection. No platform skip was added.

Native Safari 26.5 on iOS Simulator 26.5 build 23F77 passed 81 selected cases in 10 files at 402 by 714 CSS pixels and DPR 3. The other 290 registrations were filtered out. Chromium first passed 370 of 371 affected cases. The remaining font-assignment count was corrected, and the final three-file run passed all 48 cases. Independent review found that pixel mode also needed to forward font assignments to its real measurement context. That fix and cleanup on failed reference creation passed five further native cases, including both actual Canvas modes. Chromium then passed all 77 cases across the six affected Canvas and pixel files. Typechecking, lint, formatting and the build passed.

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

- The November 6 font follow-up found that cached replacement emits `loading` after the face is already loaded, without a completion event. Resource refresh now tracks new face identities at loading start and waits for `fonts.ready`, while coalescing completion events. Exact pixels and changed-metric geometry passed 14 native cases covering all seven supported variants with cached and fresh URLs. Preloaded faces added without a loading event still need explicit invalidation. This does not qualify native WebGPU or the full suite.
- `src/render/dom/renderer.browser.test.ts`, case `keeps real focus, drag selection, wheel, and mouse reporting under forced DOM fallback`, returns body as the active element after the provider click. The two real clipboard cases in `src/dom/tests/selection-packaged.browser.test.ts` never set the click callback's baseline promise. The two trusted clipboard cases in `src/dom/tests/selection-history.browser.test.ts` wait for callbacks. Qualify the native adapter's click, iframe coordinates and user activation before assigning these five failures to the product. Do not infer absence of clipboard support from them.
- The native-only GPU suites and large viewport suites need a suitable device or separately designed compact fixtures. Do not replace explicit WebGPU tests with WebGL or count failed hooks as passing tests.

## Unresolved strict composited capture, November 12, 2026

Owner disposition: keep the strict composited-pixel contract. No repaint route, calibration,
inferred inset, new exclusion, changed tolerance or original-test rewrite is authorized.
PR 129 is closed as an unqualified candidate and its branch is retained.

The native viewport route failed its first positive because its image extent differed from
the public visual viewport. One diagnostic then retained genuine official callback pixels
and stable geometry. No recorded public metric supplied the observed content origin.
Upper solids, grey and all stripe samples were exact, while lower expected colors failed
inside the predicted visible rectangle. A constant offset does not establish the required
exact bound-content contract. These observations establish no upstream specification defect.

The following originals' shared displayed-pixel paths remain unresolved under this contract:

- `src/bidi/paint.browser.test.ts`, through `src/bidi/tests/browser-capabilities.ts`.
- `src/dom/tests/terminal-ui.browser.test.ts`.
- `src/dom/tests/zig-frame.browser.test.ts`.
- `src/render/tests/held-output.browser.test.ts`.
- `src/render/tests/ligatures.browser.test.ts`.
- `src/render/tests/zig-unicode.browser.test.ts`.
- `src/render/webgl/renderer.browser.test.ts`.
- `src/render/webgl/tests/fixture.browser.test.ts`.
- `src/render/webgl/tests/native-attribution.browser.test.ts`.
- `src/render/webgl/zig-frame.browser.test.ts`.
- `src/worker/ligatures.browser.test.ts`.

Historical source-specific receipts remain unchanged; this entry neither retracts their
recorded outcomes nor promotes them to current strict-compositor or whole-root acceptance.
The separate CSS-scale and oversized-caller findings remain unresolved. No additional
skip, not-applicable row or denominator change is introduced.

Reopen only when a supported capture of the bound tester's composited content establishes
the rectangle origin, device scale and exact visible colors without calibration or repaint.
Qualify that capability with the source-bound positive controls and ordinary retirement
and cleanup, then run the unchanged original fixture and affected regressions. A desktop
pass, matching image dimensions or a measured offset in one image is insufficient.

Private evidence and the complete decision record are retained by the iOS coordinator at:

- `/work/reports/wave-20261112/ios-suites-takeover/native-capture/OWNER-DECISION.md`.
- `/work/reports/wave-20261112/ios-suites-takeover/native-capture/native/REPORT.md`.
- `/work/reports/wave-20261112/ios-suites-takeover/native-capture/diagnostic/REPORT.md`.
- The adjacent diagnostic `analysis.json` and `analysis-detail.json` contain derived facts.

Raw private screenshots and simulator database snapshots are removed after this record,
under the explicit owner instruction. Sanitized results, hashes, source and cleanup records
remain. Nothing was posted upstream. Waffle releases, group-pin work and bootstrap
diagnosis continue independently.

The retained controller, exact selections, candidate diff, native identities, per-case results and actual-host cleanup receipts are in the evidence directory above. Original run receipts are untouched. Every new native session and driver was deleted, task tunnels stopped, scratch removed, and the Mac lock released. The track-owned simulator remains under its existing cleanup owner.
