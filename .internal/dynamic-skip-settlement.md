# Dynamic capability skip settlement

Status: Approved.

Vitest 5.0.2 completes dynamic-skip cleanup and returns before its final task hook.
Our browser bridge publishes final native collector outcomes from that hook, so
skipped cases previously started without receiving an outcome.

The existing Vitest patch now calls the same final hook after dynamic-skip cleanup,
before publishing the task-finished update. Ordinary completion is unchanged.
Collector records remain `skip`; acquisition errors remain failures and supported
siblings still execute. The native completion policy and fixed exclusions are unchanged.

`scripts/ios-browser-dynamic-skip.test.ts` drives the real patched browser bridge
into the installed Waffle collector. Its synchronous, asynchronous and setup-hook
skips must settle exactly once, after both afterEach and aroundEach cleanup. It
also runs the transferred-canvas capability probe and an intentional acquisition
failure. The test belongs to the existing Node CI discovery and passes in Chromium
and Linux WebKit. It provides no native Safari qualification.

The control failed before the patch because skip outcomes were missing. The final
checks pass builds, root and shader typechecks, focused lint/formatting and both
browser collector controls. An unrelated upstream returned-beforeEach cleanup
issue is recorded in `/work/reports/upstream-bugs/`; it is not patched here.
