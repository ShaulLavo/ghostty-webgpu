# Complete original module-mock preparation

Status: Approved source preparation. Native execution remains parent-owned.

The module-mock stage selects all of `src/dom/tests/module-mock.browser.test.ts`.
Its single case and module-level mock factory stay byte-identical to main
5232c8bae87aabe8f915c4b3ea927f2f749fa74c and the October 31 source inventory.
The canonical November 5 WORKERS.json and November 7 batch02 native result contain
no native completion receipt for this file. This adds no native credit.

The existing ExpectedCase manifest, parser, source hash, and result verifier select
this file without modifying the provider or adding a controller. Installed Vitest
uses its server-side default mock registry when the WebdriverIO provider has no
mocker. That path uses existing Vite and WebSocket handling, not a Safari command.
The original factory returns the intercepted string. The case also loads the real
package exports and checks the original JSON output.

All helpers, hooks, parameter rows, loops, assets, and clocks remain unchanged.
This file has no local helper, lifecycle hook, parameter row, or font or Wasm asset.
Its external package is locked at @discoveryjs/json-ext 1.1.0. Cases keep 15-second
timeouts, hooks keep 30 seconds, and retries stay zero.

Earlier viewport, bulk-snapshot, font, measurement, asynchronous batch01, and text
batch02 receipts remain separate and are not rerun. The fixed 35 touch and 16
not-applicable records do not change. No root denominator is inferred.
