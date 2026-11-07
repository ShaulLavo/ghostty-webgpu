# Run a selected browser file on iOS

This source-only route uses the published Waffle 0.0.111 framework host and the normal Vitest lifecycle. It does not run the whole browser suite.

## Prerequisites

Use an exclusive checkout, Bun 1.4.4, and Node 26.12.1 on macOS. Install dependencies with `bun install --frozen-lockfile`. The lockfile pins the public Waffle runtime tarball and its integrity. Waffle, WebdriverIO, and Undici are development dependencies, not terminal runtime dependencies.

The parent execution owner must supply an already selected iOS Simulator UUID and own the Safari turn. Follow the fleet and device procedures before running this command. The runner does not reserve or boot a simulator. Do not run concurrent native stages.

## Select one complete file

Run the synthetic stage first. Supply a new absolute result path in an existing writable directory.

```sh
bun run test:browser --native-ios --stage synthetic --udid "$SIMULATOR_UUID" --result "$RESULT_DIRECTORY/synthetic.json"
```

The other supported stages are `viewport`, the complete five-case saved-viewport file, `bulk-snapshot`, the complete one-case bulk-snapshot file, and `font-resources`, the complete five-case font-resource file. The font stage expands both original retirement parameters and uses the checked-in replacement WOFF2 plus the original invalid data URL. It needs no additional provider operation. Each stage has an independent manifest. Source hashes reject changed registrations before allocation. There is no arbitrary file or name filter on this route.

The equivalent explicit source command is:

```sh
node scripts/ios-browser-launch.ts --stage viewport --udid "$SIMULATOR_UUID" --result "$RESULT_DIRECTORY/viewport.json"
```

A sound selected-file run exits **4**, including when every selected case passes. Capture that status explicitly in shell automation. Infrastructure or cleanup failure exits 2. Invalid preconditions exit 3. The result preserves ordinary test failure independently, and `rootBrowserSuiteComplete` always remains false. No current root denominator is inferred from historical inventories.

The read-only verifier checks a recorded result and its separate launcher receipt:

```sh
node scripts/ios-browser-verify.ts viewport "$RESULT_DIRECTORY/viewport.json"
```

Verifier exit 0 means that the recorded partial-file check passed. It does not change the run's exit 4 or establish whole-root acceptance.

## Keep ownership and scope explicit

The host mounts before session creation. The parent alone creates and deletes the session. The provider detaches on close and rejects reopening. The owned Undici dispatcher stays installed until actual framework, server, provider, session, and callback joining finishes. The outer Node process has a finite joining bound. Retain results and any unconfirmed cleanup resources for the parent rather than retrying automatically.

Native stages preserve 15-second cases, 30-second hooks, zero retries, original geometry, and all original test bodies and assertions. Only the automatic logical viewport measurement receives a permit. Explicit viewport changes, trusted input, screenshots, and CDP commands remain unsupported.

Ordinary `bun run test:browser` still uses Playwright, the existing browser selection, and `insertText`. The native module loads only in instrumented documents.

## Interpret the tests

The discovered `scripts/ios-browser*.test.ts` tests include public installed-package contracts, no-browser SDK plus Vite and WebSocket controls, real Chromium with a labelled observation double, ordinary desktop input, process joining, and read-only result guards. The observation double proves Ghostty lifecycle ordering and RPC behavior. It does not prove Waffle document binding or native retirement.

Historical native synthetic, viewport, and bulk-snapshot results used unpublished archive 06. They are not native runs of release 0.0.111. Their unknown SDK session-context warning remains unresolved evidence, not a claim of zero unsupported Safari HTTP. This supported dependency adoption does not add native or whole-root qualification, exclusions, skips, or relaxed clocks.

The font-resource stage is source-prepared only. Ordinary Chromium execution does not establish native font-event behavior or release 0.0.111 qualification. The parent must supply a fresh Safari turn and keep the selected-file exit 4 and whole-root false distinction.

The `measurement` stage selects the unchanged four-case public width and geometry file. It preserves the title and data parameter rows, the terminal and host cleanup hook, and the original 320 by 120 CSS host. It uses the checked-in `ghostty-vt.wasm` and `bridge.wasm` with normal platform font fitting. No screenshot, trusted input, explicit viewport operation, or new host API is needed. This stage is source-prepared only. Desktop success is not Safari qualification.

The asynchronous ownership batch adds three independent stages. `write-queue` runs the
complete five-case file, `presentation` runs all three cases including the original
`undefined` and `canvas2d-fill-text` parameters, and `scrollbar-async` runs its complete
one-case file. Run these stages sequentially in one separately parent-owned Safari turn,
with a new result and launcher receipt for each stage. The scrollbar file dispatches its
original synthetic `WheelEvent`; it does not request trusted provider input.

These stages preserve all cleanup hooks, animation-frame waits, the five-second write
settling deadline and ten-millisecond polling, normal fonts, and the checked-in Wasm
assets. The presentation file retains its automatic backend choice. No new host API,
controller, viewport command, screenshot, fixture input, or clock override is introduced.
All three are source-prepared only. Host exit 4 and verifier exit 0 remain selected-file
evidence, never whole-root completion or native qualification from desktop results.

The text API batch adds `history` and `readline-layout` as independent stages. Run them
sequentially with separate results and launcher receipts. The complete history file
has five cases, including both main and worker parameter rows. It retains its original
Chromium suite title, 20,000-line input, row-cap loop, normal automatic backend choice,
and actual JetBrains Mono worker font. The complete multiline file has two cases using
the built line-editor addon, original paste and key API calls, Canvas renderer, six-row
grids, zero-millisecond settling wait, and soft cursor assertion. These are terminal
API calls, not trusted provider input. Both files retain their original cleanup hooks.

Only source preparation and ordinary desktop evidence belong to this batch. No native
run or startup-cause fix is claimed. Keep earlier source-specific passed records separate.
Waffle, provider operations, clocks, exclusions, and whole-root false semantics do not change.

The `module-mock` stage selects the complete one-case module-mocking original. Its
factory, mocked import, `vi.importActual` call, and both exact string assertions remain
unchanged. Vitest resolves the package through its existing Vite mock registry and
WebSocket RPC. No trusted provider command, font, Wasm asset, helper, hook, explicit
viewport change, or database operation is required. The locked package is
`@discoveryjs/json-ext` 1.1.0. This stage is source-prepared only. Run it only in a
separately parent-owned Safari turn after review and ready-head CI. Selected-file host
exit 4, verifier exit 0, and whole-root false semantics remain unchanged.
