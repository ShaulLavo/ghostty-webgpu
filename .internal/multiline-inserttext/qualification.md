# Multiline insertText qualification

Status: Approved. Implementation handoff is pending independent review and merge.

## Current source

The exclusive T3 branch starts at fetched origin/main `281fe63bf08221a7c92d6923eb8a5c02f6acc327`. One fetch on November 1, 2026 confirmed the coordinator's base. Recent input-related fixes cover scroll return, optional hotkeys and macOS key defaults. They do not change the textarea value fallback. The fallback in `src/dom/input.ts` dates to `50788b2c6`. The composition state machine dates to `b6ff06629`.

The latest release tag observed is `v0.3.30-a322323`. The frozen consumer at `40a0cb891f8b4f6aa0b8ed3d19669f56252b3fa9` remains a separate finding. Its report and oracle were not changed.

## Reproduction

A maintained browser command calls the provider's actual `page.keyboard.insertText(text)`. Vitest's `page` is not a Playwright Page. Vitest `userEvent.type` sends individual key actions instead, so neither was accepted as the reproduction. The custom command exists only in the test configuration.

With unchanged production source, Chromium and WebKit each fail both initially empty and selected replacement cases. Exact public data chunks are `["A Ω世界🙂\nsecond", "second"]`. The expected chunk is `["A Ω世界🙂\nsecond"]`.

## Cause and design

The textarea holds the complete browser edit at the first input callback. The controller consumes and clears it. Later callbacks from that same edit hold only fragments in `InputEvent.data`; the existing fallback treats them as fresh payloads.

Two local designs were considered. Consuming `beforeinput.data` and cancelling the browser edit would replace native selection and composition behavior, so it was rejected. Tracking whether the edit's textarea payload has already been consumed preserves the existing browser mutation and synchronous clearing. The next `beforeinput` opens a new edit regardless of text equality. Composition, paste and lifecycle reset retain their own ownership.

The chosen private `InputSequence` is `idle | pending | consumed`. Only a sequence that actually announced `beforeinput` blocks an empty-value fragment fallback after consumption. A fresh nonempty textarea value remains consumable, even when no beforeinput was delivered. There is no text comparison, timeout, content normalization, native input substitution or change to encoders.

## Scope and deviations

No frame, renderer, WASM, native producer, version, release or package pin changes. No Mac, device, GUI window or deployed app was used. The task forbids children, so architecture exploration and code review are local. The parent owns fresh independent review, hosted checks and guarded merge.

The source browser regression uses the repository's existing real runtime and recording renderer. Package behavior is checked against a normal build because consumers execute dist. No new observer is accepted as an oracle.

## Verification receipts

The failing-test commit is `e77c0c21e`. A baseline rebuild produced six focused failures in each engine, including the built-package path. The correction makes all 32 input tests pass on WebKit. Chromium passes all 113 tests across the input, extension and hotkeys-focus files.

The wider WebKit run passes 111 tests and fails two worker-renderer cases before text input can run. Rebuilding the untouched base reproduces both failures with `The browser cannot run the requested terminal worker.` No assertion, engine admission or baseline was changed. The actual insertText regressions remain green on WebKit.

Normal build, typecheck, lint, formatting, extension package checks and docs examples pass. Unit validation passes 1,276 Vitest tests, 485 comparison tests, four checkpoint tests and two codec tests. One pre-existing Vitest test remains skipped. The existing lint warnings are outside the changed input files.

The source test controls cover exact command text, Unicode middle insertion, independent identical edits, keyboard input, composition completion, event-data fallback boundaries, clipboard paste, reset, extension claims and synchronous textarea clearing. Package tests repeat identical multiline input twice and compare the actual public Uint8Array chunks without normalization.

## Principles applied

Fix Root Causes kept the change at textarea payload ownership rather than text matching. Model the Domain made the edit lifetime an explicit three-state value. Laziness Protocol kept production changes in one existing input file. Prove It Works required both actual Playwright insertion and built-package byte assertions. Sequence Work into Verifiable Units put the failing tests before the fix in history.
