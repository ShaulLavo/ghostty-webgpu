# BiDi WebKit failure classification

Base: `04a97afc39b74b7c4ee5dcd23b0682123e44e8b8`. Playwright 1.63.0, Vitest 5.0.2, Bun 1.4.4.
Integrated validation base: `b896d85518961da3ee0e02fa2d52c353b8c8dfd9`, after C2 ligatures merged.
Raw evidence: `/work/reports/ghostty-webgpu-next-2026-10/bidi-webkit/`.

## Findings

No BiDi product defect was reproduced. Linux WebKit initially failed 31 of 99 tests, passed 45,
and skipped 23 for unavailable WebGPU. Mac WebKit passed all 99 on both the base and corrected tests.
All Mac runs held the fail-closed task lock. The final Mac repeat after C2 also passed all 99.
The initial Mac launch needed WebKit revision 2359 downloaded into a task-owned browser directory;
it did not execute tests.

Ten DOM failures came from the test oracle. An inline reference canvas placed the next control
at Y=323.5 CSS pixels. Linux WebKit captured 161 screenshot rows for a 160-pixel element, adding
a background row and shifting glyph pixels. The terminal frame remained at integer geometry.
The oracle canvas now uses block layout. A failing-first geometry assertion reports
`expected [ 400, 161 ] to deeply equal [ 400, 160 ]`; all ten DOM comparisons now execute and pass.
Screenshot size and the existing two-channel-value tolerance remain strict.

Thirteen WebGL2 screenshot tests hit the known Linux headless WebKit presentation limit.
A standalone canvas, independent of terminal code, clears red and verifies all framebuffer bytes
and the GL error before capturing it. Only a screenshot containing the canvas CSS background
throughout enables the explicit skip. Unexpected pixels, GL errors, and unreadable framebuffers
fail the suite. Reflow and disabled-option WebGL tests continue running. This follows C2's
capability approach without using terminal output to decide whether to skip its own assertions.

Eight worker interaction failures came from a transferred OffscreenCanvas returning null for
WebGL2 in an independent module worker. Only that detected absence enables their explicit skip.
The probe rejects unexpected replies, worker errors and timeouts, and always terminates the worker.
It does not catch or skip terminal startup errors.

## Every original failure

| Test                                                                                             | Cause                          | Resolution                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------ | --------------------------------------- |
| BiDi webgl interactions > copies visual drag 1 to 8 in logical order                             | Worker WebGL2 unavailable      | Capability skip on Linux; passes on Mac |
| BiDi webgl interactions > copies visual drag 8 to 1 in logical order                             | Worker WebGL2 unavailable      | Capability skip on Linux; passes on Mac |
| BiDi webgl interactions > copies visual drag 3 to 6 in logical order                             | Worker WebGL2 unavailable      | Capability skip on Linux; passes on Mac |
| BiDi webgl interactions > copies visual drag 3 to 1 in logical order                             | Worker WebGL2 unavailable      | Capability skip on Linux; passes on Mac |
| BiDi webgl interactions > uses logical word boundaries and programmatic ranges                   | Worker WebGL2 unavailable      | Capability skip on Linux; passes on Mac |
| BiDi webgl interactions > maps OSC 8 hover and paints the logical link cells                     | Worker WebGL2 unavailable      | Capability skip on Linux; passes on Mac |
| BiDi webgl interactions > reports logical SGR columns and stops after mouse tracking is disabled | Worker WebGL2 unavailable      | Capability skip on Linux; passes on Mac |
| BiDi webgl interactions > maps both columns of a wide glyph for application mouse reports        | Worker WebGL2 unavailable      | Capability skip on Linux; passes on Mac |
| BiDi dom > maps and paints mixed at DPR 1                                                        | Oracle layout                  | Fixed; runs and passes                  |
| BiDi dom > maps and paints numbers at DPR 1                                                      | Oracle layout                  | Fixed; runs and passes                  |
| BiDi dom > maps and paints punctuation at DPR 1                                                  | Oracle layout                  | Fixed; runs and passes                  |
| BiDi dom > maps and paints arabic at DPR 1                                                       | Oracle layout                  | Fixed; runs and passes                  |
| BiDi dom > maps and paints wide at DPR 1                                                         | Oracle layout                  | Fixed; runs and passes                  |
| BiDi webgl > maps and paints mixed at DPR 1                                                      | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps and paints numbers at DPR 1                                                    | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps and paints punctuation at DPR 1                                                | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps and paints arabic at DPR 1                                                     | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps and paints wide at DPR 1                                                       | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi dom > maps and paints mixed at DPR 2                                                        | Oracle layout                  | Fixed; runs and passes                  |
| BiDi dom > maps and paints numbers at DPR 2                                                      | Oracle layout                  | Fixed; runs and passes                  |
| BiDi dom > maps and paints punctuation at DPR 2                                                  | Oracle layout                  | Fixed; runs and passes                  |
| BiDi dom > maps and paints arabic at DPR 2                                                       | Oracle layout                  | Fixed; runs and passes                  |
| BiDi dom > maps and paints wide at DPR 2                                                         | Oracle layout                  | Fixed; runs and passes                  |
| BiDi webgl > maps and paints mixed at DPR 2                                                      | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps and paints numbers at DPR 2                                                    | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps and paints punctuation at DPR 2                                                | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps and paints arabic at DPR 2                                                     | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps and paints wide at DPR 2                                                       | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps block cursor cells                                                             | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps bar cursor cells                                                               | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |
| BiDi webgl > maps underline cursor cells                                                         | WebGL2 screenshot presentation | Capability skip on Linux; passes on Mac |

## Verification

| Host and engine           | BiDi result                       |
| ------------------------- | --------------------------------- |
| Linux Chromium full suite | 1,383 passed, five existing skips |
| Linux WebKit base         | 31 failed, 45 passed, 23 skipped  |
| Linux WebKit corrected    | 55 passed, 44 skipped             |
| Linux Firefox corrected   | 76 passed, 23 skipped             |
| Mac WebKit base           | 99 passed, zero skipped           |
| Mac WebKit corrected      | 99 passed, zero skipped           |

The 44 Linux WebKit skips comprise 23 existing WebGPU skips, 13 screenshot capability skips,
and eight worker capability skips. Supported engines execute the original assertions.

Build, typecheck, lint, format, unit, extension, and site docs checks pass on the integrated base.
Node Vitest passed 1,266 tests with one existing skip; the additional Bun and Node checks also passed.

The full browser gate is the critical path. PC work uses the shared queue, while locked Mac checks
run independently. One pre-C2 Chromium run was interrupted when shared renderer code changed.
The full gate restarted after rebuilding and repeating extension checks, then passed all 76 files.
The final Linux Firefox and WebKit checks repeated on that integrated revision.

Reproduce with `GHOSTTY_BROWSER_ENGINE=webkit bun run test:browser src/bidi/ --reporter verbose`.
Substitute `firefox` for the Firefox check. Chromium's full suite runs after `bun run verify:extensions`.

Fix Root Causes led to correcting oracle layout rather than changing the renderer or pixel tolerance.
Prove It Works led to independent browser controls and base/final Mac runs. Build the Lever led to
rerunnable capability probes in the test tree. Delegated architecture and review steps were skipped
because the binding implementation brief forbids child agents; the coordinator owns review and merge.
