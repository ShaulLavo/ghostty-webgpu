# Legacy Unicode diagnostic

The comparison smoke runs the pinned `ghostty-web` 0.4.0 original Unicode diagnostic
in its own Chromium process. The renderer correctness page stays alive for the later
instrumentation check, and the runner continues subsequent native and xterm cases.

Each legacy case first runs a control in another fresh browser. It uses one loaded
runtime and the documented Terminal API to write 35 ASCII chunks. The original probe
keeps its Unicode corpus, 35-write limit, second runtime, and documented/core API calls.
The pinned declaration documents passing a Ghostty instance to the Terminal constructor
for test isolation. Multiple runtime construction alone does not establish API misuse.

`legacyWriteControl` and `originalUnicodeProbe` in `comparison.json` record their status,
browser version, page errors, and renderer crash event. `originalUnicodeTrace` retains
the last observed API call and write/frame boundary. A caught WASM trap or renderer
crash makes the smoke exit nonzero after the remaining cases complete.

The case owns each pending browser launch before acquisition starts. A deadline closes
the browser as soon as acquisition finishes and prevents later diagnostic work. Cleanup
finishes before ownership is released, and a crash observed during teardown forces failure.

This change contains the dependency failure. It does not repair the upstream WASM fault
reported in [Fregat #363](https://github.com/ShaulLavo/fregat/issues/363), and it changes no
measurement workload or frozen benchmark receipt.
