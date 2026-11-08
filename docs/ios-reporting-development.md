# Browser reporting development controls

This draft changes reporting, not the supported Waffle dependency. The manifest, lockfile and
`frameworkRelease` still select 0.0.111. The new factory signatures need the separately supplied
development candidate. A normal supported-pin typecheck cannot qualify this draft.

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

## Isolated installation

Use an exclusive T3 tree. Verify the supplied archive against its parent-owned identity before
copying it. Install the ordinary frozen dependencies with `--backend copyfile` and a private
`--cache-dir` under owned scratch. Extract the candidate into that scratch and copy its package
contents over this tree's installed Waffle only. Check that `realpath node_modules/waffle` is
inside this tree's `node_modules` before writing. Do not edit the manifest, lock, release identity,
shared cache or SDK source. Do not commit the archive or installed package.

The changed upstream patch must also be applied to this tree's installed `@vitest/browser`.
Patch hash changes are deliberately not adopted into the durable lockfile in this development
unit. The parent owns supported adoption and normal integration CI.

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
browser tester, the candidate's actual bootstrap/accessor, the actual collector and held real
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
remain failed and make the development command fail. Negative infrastructure controls expect
SDK status 2 without converting ordinary case outcomes into infrastructure errors.

Keep candidate failures visible. The parent owns the corrected SDK, independent implementation
review, supported release adoption, normal CI and native qualification. This draft is not ready
to merge or publish.
