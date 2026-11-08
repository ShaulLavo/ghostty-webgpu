# Bound viewport and screenshot adapter

Status: Development draft. Do not merge or run originals until a supported Waffle successor is released and adopted. The committed dependency remains published 0.0.111, which cannot type-check these new operations.

## Source contract

The adapter captures the exact official screenshot callback through Vitest's public generic registrar during superclass construction. It restores the registrar in `finally`, requires exactly one capture, and keeps execution disabled until the provider checks are installed. It forwards the original callback receiver, context, payload objects, result, and Buffer.

Each screenshot snapshots its project, browser project, provider, attached SDK browser, framework session ID, native session descriptor, and actual framework file. The native descriptor includes every scalar field supplied by the original connection options, with keys derived from that object. The admitted callback checks that snapshot synchronously immediately before invoking the official callback. It checks again after settlement. An official rejection wins by identity over a failed post-check; secondary context faults are retained separately without inspecting the rejection.

Explicit viewport calls use `host.provider({ kind: 'viewport', width, height })`, without a callback. Vitest still sets iframe CSS and delivers its ordinary completion events. The adapter does not resize a native window, normalize screenshot options, parse images, or implement capture/save itself.

Ordinary sequential calls work, including hooks, restoration, and same-size repeats. Vitest's existing completion event identifies an iframe, not an individual request. Concurrent requests for one iframe therefore do not have independent completion correlation. The host queue does not repair that limitation.

## Combined synthetic control

`ios-browser-bound-operations-combined.test.ts` is in ordinary Node test discovery. It starts a separate Node process for each mode. The process uses `createVitest.start`, the installed official WebDriverIO provider and SDK, Ghostty's existing instrumentation plugin and dispatcher, and Waffle's public `createFrameworkControl` host. Its loopback WebDriver fixture evaluates the host's actual scripts in real Chromium top and tester documents. Both documents must be admitted in that same run.

The browser case uses ordinary `page.viewport` calls. Screenshot capture happens with an actual 414-pixel tester and an unchanged 480-pixel element. The official callback performs real lookup, SDK response decoding, file saving, and temporary-file removal. A deferred screenshot HTTP response proves that the callback and the next root operation cannot finish early. The exact SDK Buffer survives the callback and host queue.

The PNG response is **SYNTHETIC TRANSPORT bytes**. It is not an image of either document and proves nothing about native pixels, cropping, DPR, or clipping.

The modes cover queued and settlement-time context mutations, native descriptor changes, wrong window/frame/document, transient removal, same-URL frame replacement, local closure, cleanup, both pagehide latches, exact rejection identity, and denied work after closure. Queued denials must create no screenshot directory, target lookup, or capture.

For falsy callback rejections, a one-shot public project-configuration getter rejects inside the unchanged official callback and changes its context before the adapter's post-check. The SDK command wrapper otherwise swallows injected falsy command rejections. The hostile-rejection mode instead awaits the actual public SDK save command before rejecting. Neither mode replaces the official screenshot callback.

## Development qualification

The local candidate archive is `waffle-0.0.113-development-3451d51f.tgz`, source `3451d51fcd993be506f2083ea55d3f041bb2d0b8`, 3,395,813 bytes, SHA-256 `cdae8a8b19e7f48ffa150f14154b497f8f2342c822c68c439703942f0d177a51`. This is not published 0.0.113 and excludes the separate declared-clock and asset-hold changes.

Use an isolated dependency project with its own package manifest, private copyfile installation/cache, and resolved-parent checks. Leave the repository manifest and lock unchanged. With that temporary SDK override:

- Run `node node_modules/vitest/vitest.mjs run scripts/ios-browser-bound-operations-combined.test.ts`.
- Run `node node_modules/vitest/vitest.mjs run scripts/ios-browser-bound-operations.test.ts scripts/ios-browser-types.test.ts scripts/ios-browser-controls.test.ts`.
- Compile the adapter and combined controls with strict TypeScript.

Local receipts and the setup reproducer are in `/work/reports/wave-20261108/ios-suites/ghostty-bound-operations-consumer/`.

No original case, stage selection, corpus, registry, exclusion, package pin, or release version changes here. Native Safari geometry/capture, trusted input, actual pixels, supported-release adoption, ordinary CI, and independent parent review remain separate gates.
