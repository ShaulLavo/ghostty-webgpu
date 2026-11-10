# Browser reporting controls

These controls use the published Waffle 0.0.118 runtime, source
`6e0608451a3f89c1fa0e4f17dacdc6edc5cbc900`, host interface 2. The manifest, lockfile,
and `frameworkRelease` bind the same public archive. The complete development tuple also
pins relay 0.0.118 and programs/base 0.0.20. The reporting controls do not start the relay
or execute program families. Their original guest source remains
`3050f69d810fe7c851e487135517698b5dfd93e5`.
CPU source checks do not qualify framework hook pacing or native execution.

## Upstream adaptation

`patches/@vitest%2Fbrowser@5.0.2.patch` adapts the installed MIT-licensed
[`@vitest/browser` 5.0.2](https://www.npmjs.com/package/@vitest/browser/v/5.0.2), from the
[Vitest repository](https://github.com/vitest-dev/vitest/tree/v5.0.2/packages/browser).
It retains the existing document instrumentation and initial viewport changes. This revision
adds awaits in the installed tester's collection, task-start, settlement, suite, execute and
cleanup owners. The orchestrator observes its matched cleanup response before retirement.
The bridge contains reporting rejection. It never joins or replaces an original update RPC.

The tester error path still tees the raw error, reads the original three fields and swallows
the original RPC rejection. The browser catcher keeps its one serializer, synchronous DOM
dispatch and original connection/RPC/catch expression. Test-only error inspection appends a
reference to the actual loaded tester's function and client. It does not copy a hook body,
replace the runner or modify the committed upstream patch.

## Installation

Use an exclusive T3 worktree and run `bun install --frozen-lockfile`. The committed Vitest
patch applies through Bun's normal patched dependency mechanism. Do not overlay a development
SDK, patch Waffle, or replace the installed package. The published archive already contains
the Node framework host and browser bootstrap.

The release identity in `scripts/ios-browser-dependency.ts` records the public URL, source,
byte count, SHA-256, SHA-512 integrity, and host interface. The discovered source tests require
the installed version and host interface, matching manifest and lock, one Vitest browser
resolution, and browser-only page imports.

## Exact commands

Create a writable evidence directory and short owned temporary directory under `/work`.
Use the fleet's live availability check and the local runner. Ports 19761, 19762 and 19763 must
be free. The fixture uses strict ports and no automatic fallback.

```sh
GHOSTTY_REPORTING_EVIDENCE="$EVIDENCE" STORAGE_SCRATCH_ROOT="$SCRATCH" TMPDIR="$SHORT_TMP" \
  bun /work/heavy-runner/current/run.js --host local --class browser reporting-installed -- \
  node scripts/ios-browser-reporting-installed.ts
```

The default includes exactly `scripts/ios-browser-reporting.synthetic.browser.test.ts` and
registers 38 separate synthetic cases. It uses normal `createVitest.start`, the actual patched
browser tester, the release's actual bootstrap/accessor, the actual collector and held real
collector responses. It checks collection/body, settlement/next-body, execute-response and both
cleanup-response barriers. Nested and concurrent cases retain normal scheduling.

Append `--flush` for the separate one-case
`scripts/ios-browser-reporting-flush.synthetic.browser.test.ts` control. Its natural throttler
runs while the body is active. The original RPC result and collector ACK are held independently.
After ACK release, final execution remains blocked on the original RPC, not a reporting join.

Append `--errors` for the separate three-case
`scripts/ios-browser-reporting-errors.synthetic.browser.test.ts` negative. Reporting admission
fails first. The actual installed update, tester error, DOM browser error and actual cleanup
error still dispatch. The ordinary cases must pass while infrastructure fails and the file
remains incomplete. Falsy RPC rejection and property-read traces are retained.

Append `--capacity` to run the same three-case negative with 65 actual tester error calls.
The admitted prefix and refused record remain distinct. All 65 original error RPC calls,
a later update, the browser error and actual cleanup error still dispatch. Transport
cancellation remains uncertainty, not successful prefix delivery.

Append `--malformed` for the same three original-dispatch controls after the actual collector
ACK is corrupted. This uses the SDK's unchanged retry budget and retains the original encoded
retry bodies. No reporting failure is relabeled as an ordinary task failure.

The separate `scripts/ios-browser-reporting-host.test.ts` CPU control holds an actual
registered host provider callback. A bounded heartbeat failure reaches the actual collector
and starts containment while that callback remains held. Scratch stays present until the
callback settles. It is host callback ownership evidence, not a browser lifecycle substitute.
It uses explicit port 19764 and no driver session.

```sh
bun /work/heavy-runner/current/run.js --host local --class light reporting-unit -- \
  bunx --no-install vitest run scripts/ios-browser-reporting.test.ts scripts/ios-browser-reporting-source.test.ts scripts/ios-browser-records.test.ts scripts/ios-browser-reporting-host.test.ts
```

The unit accessor double tests bridge containment only. The small child realms inside the
38-case file run the shipped SDK bootstrap with a synthetic transport. They test admission,
conversion and encoding, not framework hook pacing or host cleanup. The real paired collector
fixture supplies the hook-pacing evidence. The HTTP WebDriver bridge drives real Chromium DOM,
not Safari, and supplies no native, pixel, original-suite or memory-release credit.

## Results and ownership

The runner releases held responses before joining its context, transport, routes and browser.
It writes `installed-trace.json` and the SDK's `host-result.json` to the evidence directory.
Successful selected-file SDK status is 4, never whole-root completion. Ordinary failed cases
remain failed and make the control command fail. Negative infrastructure controls expect
SDK status 2 without converting ordinary case outcomes into infrastructure errors.

Keep earlier development candidate failures visible as historical evidence. The parent owns
independent adoption review, merge, and fresh native qualification. Public runtime adoption
does not turn earlier development results into supported-release proof. The page-owned trace
fixture is implemented but its five native modes remain unexecuted in this adoption.
