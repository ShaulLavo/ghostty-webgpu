# Bound viewport and screenshot adapter

Status: The enclosing-capture implementation is ready for coordinator-owned independent source review and native qualification on main `5c6d00f076047bdc4090454543ec56d31198c94d` and public Waffle 0.0.118. See [the native capture note](ios-native-capture.md) and [the historical refresh receipt](ios-bound-operations-refresh.md).

## Source contract

The adapter captures the official screenshot callback through Vitest's public generic registrar during superclass construction. It restores the registrar in `finally`, requires exactly one capture, and keeps execution disabled until the provider checks are installed. The receiver, context and screenshot name remain unchanged. Requests outside the enclosing device-capture scope retain their original payload, result and Buffer.

Each screenshot snapshots its project, browser project, provider, attached SDK browser, framework session ID, native session descriptor, and actual framework file. The native descriptor includes every scalar field supplied by the original connection options, with keys derived from that object. The admitted callback checks that snapshot synchronously immediately before invoking the official callback. It checks again after settlement. An official rejection wins by identity over a failed post-check; secondary context faults are retained separately without inspecting the rejection.

Explicit viewport calls use `host.provider({ kind: 'viewport', width, height })`, without a callback. Vitest still sets iframe CSS and delivers its ordinary completion events. The adapter does not resize a native window.

Element captures with no explicit target, device scale and `save: false` now normalize inside that same owned callback. One immediate preparation brings a fitting envelope into view through scrolling containers, the tester and top viewport. Identical measurements around the one official provider-level page capture must remain stable and unobstructed. The module validates dimensions, transforms, scale and physical containment, then losslessly crops the genuine viewport PNG. It preserves the official path and temporary-file lifecycle. CSS scale, oversized captures and the WDIO provider's ignored Playwright options have no new semantics. The route rejects unsupported geometry and PNG formats instead of padding, resampling, stitching or retrying.

The screenshot command types derive from the authoritative internal BrowserCommands augmentation. pngjs and its exact type dependency remain tooling-only. Native stage `capture-control` admits one exact file with five 15-second positive cases and zero retries. Only that stage collects successful callback geometry, PNG dimensions and profile types into `<result>.captures.json`; the unchanged original stage has no capture instrumentation. Actual Safari origin, scale and color remain unqualified until the coordinator runs these positives.

Ordinary sequential calls work, including hooks, restoration, and same-size repeats. Vitest's existing completion event identifies an iframe, not an individual request. Concurrent requests for one iframe therefore do not have independent completion correlation. The host queue does not repair that limitation.

## Combined synthetic control

`ios-browser-bound-operations-combined.test.ts` is in ordinary Node test discovery. It starts a separate Node process for each mode. The process uses `createVitest.start`, the installed official WebDriverIO provider and SDK, Ghostty's existing instrumentation plugin and dispatcher, and Waffle's public `createFrameworkControl` host. Its loopback WebDriver fixture evaluates the host's actual scripts in real Chromium top and tester documents. Both documents must be admitted in that same run.

The browser case uses ordinary `page.viewport` calls. Screenshot capture happens with an actual 414-pixel tester and an unchanged 480-pixel element. The official callback performs real lookup, SDK response decoding, file saving, and temporary-file removal. A deferred screenshot HTTP response proves that the callback and the next root operation cannot finish early. The exact SDK Buffer survives the callback and host queue.

Existing modes retain **SYNTHETIC TRANSPORT bytes**. They prove nothing about native pixels, cropping, DPR, or clipping. The new enclosing modes execute the real preparation and measurement scripts in Chromium, return genuine top viewport pixels from the viewport endpoint, and check the crop samples and temporary-file removal after success or post-capture geometry rejection. The original route still returns the exact SDK Buffer. Falsy official rejection identity also passes through the normalized branch. None of these are native qualification.

The modes cover queued and settlement-time context mutations, native descriptor changes, wrong window/frame/document, transient removal, same-URL frame replacement, local closure, cleanup, both pagehide latches, exact rejection identity, and denied work after closure. Queued denials must create no screenshot directory, target lookup, or capture.

For falsy callback rejections, a one-shot public project-configuration getter rejects inside the unchanged official callback and changes its context before the adapter's post-check. The SDK command wrapper otherwise swallows injected falsy command rejections. The hostile-rejection mode instead awaits the actual public SDK save command before rejecting. Neither mode replaces the official screenshot callback.

## Historical development qualification

The November 8 qualification used a local candidate archive, `waffle-0.0.113-development-3451d51f.tgz`, source `3451d51fcd993be506f2083ea55d3f041bb2d0b8`, 3,395,813 bytes, SHA-256 `cdae8a8b19e7f48ffa150f14154b497f8f2342c822c68c439703942f0d177a51`. This is not published 0.0.113 and excludes the separate declared-clock and asset-hold changes.

That historical run used an isolated dependency project with its own package manifest, private copyfile installation/cache, and resolved-parent checks. It left the repository manifest and lock unchanged and ran these commands with the temporary SDK override:

- Run `node node_modules/vitest/vitest.mjs run scripts/ios-browser-bound-operations-combined.test.ts`.
- Run `node node_modules/vitest/vitest.mjs run scripts/ios-browser-bound-operations.test.ts scripts/ios-browser-types.test.ts scripts/ios-browser-controls.test.ts`.
- Compile the adapter and combined controls with strict TypeScript.

Local receipts and the setup reproducer are in `/work/reports/wave-20261108/ios-suites/ghostty-bound-operations-consumer/`.

No original case, stage selection, corpus, registry, exclusion, or release version changes here. The refresh inherits the public package pin from main, without a development override. Native Safari geometry and capture, trusted input, actual pixels, ordinary CI, and independent parent review remain separate gates.
