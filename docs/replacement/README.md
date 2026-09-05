# Replacement contract

This is the initial evaluation scope for Plan 016. The product remains a preview. Required rows
stay required when they fail. The comparison runner currently exercises the introductory browser
workflow and the first standalone buffer/link probes; it does not yet certify the whole contract.

## Baseline and reproduction

[baseline.json](baseline.json) pins ghostty-web 0.4.0, its npm SHA-512 integrity, and source commit
`9e4e126d89ac3537d2b2ebec075849851566de9f`. The package is an exact development dependency in the
lockfile. Its [source README](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/README.md)
and installed `dist/index.d.ts` define the starting API. Comparison dependencies are not runtime
package dependencies.

Run from the checkout:

```sh
bun install --frozen-lockfile
bun run build
bun run test:replacement
bun run test:package
```

`test:replacement` checks the baseline tarball against its pinned integrity. It compares installed
JavaScript, declarations and WASM bytes with that archive before running both packages with the
same input. It exits unsuccessfully for any failing workflow or uncaught browser error, including
a known gap. Results and screenshots go to `.artifacts/replacement/`. Results record the candidate
commit, working-tree status, tracked diff hash, built artifact hash, fixture hash, browser version,
OS, requested backend, font, DPR and loading conditions. The runner rejects changes to built
artifacts during comparison. A dirty checkout is not a release candidate identity. The first run uses
headless Chromium and forced Canvas2D. Its screenshots inspect already displayed pixels, including
a live foreground change; observation does not submit a terminal draw. This establishes neither
hardware performance nor WebGPU, WebGL2, Firefox or Safari coverage.

`test:package` packs through the normal prepack build, installs outside this checkout, and checks
browser imports without DOM globals in Node, TypeScript 7 and 5 declarations, CSS resolution,
browser bundling, WASM loading and displayed Canvas2D recoloring from the installed package.
The host resolver type fixture and runtime qualification remain in `test:package:host`.
CI runs browser verification and native artifact verification in separate jobs.

Package size evidence goes to `.artifacts/package-browser.json`. It reports the packed tarball,
installed package and transitive dependency bytes, and optional native bytes separately. Transfer
estimates compress the unminified browser bundle of both constructors and each WASM asset with gzip
and Brotli. They exclude CSS and HTTP overhead and do not imply a measured network startup time.

## Required support contract

| Behavior                                                   | Consumer need and baseline                                        | Candidate and migration                                                                                       | Evidence or remaining gap                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Initialization, construction, open                         | Upstream `await init(); new Terminal(); open(element)`            | Import `Terminal` from `/xterm`; omit global `init`; writes complete asynchronously                           | Shared open/write callback fixture passes; no import-only replacement claim                                                       |
| Fitting and container resize                               | Upstream `FitAddon.fit`, `proposeDimensions`, `observeResize`     | `/xterm` currently requires explicit `resize`; native root auto-fits                                          | Shared fitting fixture fails; equivalent compatibility workflow remains required                                                  |
| Text and binary writes, readiness                          | Shell transport and writes during async startup                   | `/xterm` queues writes, callback follows consumption                                                          | Introductory write passes; pre-open ordering, disposal races and binary comparison need expansion                                 |
| Keyboard and resize events                                 | Shell transport uses `onData`, `onResize`                         | Same subscription shape on `/xterm`                                                                           | Shared keyboard and resize fixtures pass; held keys and physical IME remain unverified                                            |
| Themes, fonts, transparency                                | Live appearance changes without lost content                      | `/xterm` live options; native root appearance methods                                                         | Shared foreground screenshot probe; backgrounds, transparency, font readiness and DPI still require comparison                    |
| Buffer lines, text, cells, cursor                          | Standalone application reads output, including history            | `/xterm` buffer API throws                                                                                    | Shared text/cell/cursor probe fails; active history needs native grid access bindings, inactive screens need an upstream selector |
| Custom links                                               | Standalone links and Platform path navigation                     | Native root supports providers; `/xterm` registration throws                                                  | Shared registration probe fails; activation, provider disposal, scrolling, wraps and canvas replacement remain required           |
| Selection, clipboard, scrolling, alternate screen, Unicode | Baseline terminal and shell/TUI workflows                         | Existing native implementation and compatibility methods                                                      | Existing tests remain evidence; direct baseline comparisons and physical input checks are outstanding                             |
| Focus and accessibility                                    | Keyboard ownership, IME and screen readers                        | Existing DOM integration                                                                                      | Earlier physical acceptance retains its original revision; current candidate checks remain outstanding                            |
| Disposal and idle                                          | Embedders open and close many terminals                           | Existing native disposal and event-driven scheduling                                                          | Shared canvas removal passes; timer/resource accounting and 1/8/17-terminal comparisons remain outstanding                        |
| Browser and embedded hosts                                 | Independent Chromium, Firefox and Safari applications, Platform   | WebGPU, WebGL2, Canvas2D fallback chain                                                                       | Only this runner's Chromium Canvas2D path is measured; supported versions and embedded-host matrix are not yet qualified          |
| Clean installation                                         | Browser users do not assemble native tools                        | Normal build and browser package checks are independent of host assembly                                      | Relocated packed-consumer check passes; additional bundler coverage remains outstanding                                           |
| Platform integration                                       | Real consumer, not a synthetic substitute                         | Checkout at `c15f16c840b6e6b8217145432cc00ac7ebfb3335` imports removed `GhosttyWebGpuTerminal` and pins 0.1.0 | Actual consumer migration and integration run remain required; do not count the standalone fixture as Platform                    |
| Startup, latency, throughput and memory                    | No material regressions; measured resource/rendering improvements | Existing renderer benchmark is a starting point                                                               | Comparison workload, repeatability-derived tolerances, alternating repetitions and hardware samples remain outstanding            |

The initial standalone buffer probe deliberately checks only one active line. Passing it later will
not establish scrollback, inactive-buffer access, grapheme, wrap or color-attribute behavior. Native
viewport snapshots cannot fulfill an API promising arbitrary history. The public native grid APIs
can provide active/history cell data, but the inactive-screen selector gap recorded in historical
Plan 009 remains relevant evidence. That gap does not block active-buffer implementation.

Custom link registration is only a registration probe. ghostty-web 0.4.0 returns `void`; the candidate
contract additionally requires removable registrations because embedders replace providers. The
runner records whether the baseline returns a disposable and makes no disposal or activation claim.

## Additional capability evaluation

| Capability                                                              | Initial disposition                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search and serialization                                                | No corresponding addon export in the pinned declarations. Evaluate application workflows before adding a package; no current comparison evidence. |
| Font loading                                                            | Required as part of correct browser startup and live fonts, regardless of addon shape.                                                            |
| Ligatures                                                               | Rendering capability still needs baseline observation; not waived by the absence of an addon export.                                              |
| Images                                                                  | Check terminal protocol behavior against the baseline before deciding support; no current pass or exclusion.                                      |
| Progress                                                                | Check protocol and consumer use; no current pass or exclusion.                                                                                    |
| Parser interception, Unicode providers, exact markers and addon aliases | Optional xterm compatibility unless a required consumer workflow demonstrates a dependency. Preserve existing behavior and ledger evidence.       |

The readiness decision still requires every required row, current displayed-output coverage,
physical acceptance where necessary, and measured comparisons against declared tolerances. No
performance or superiority claim follows from this initial fixture.

The later [renderer performance pass](renderer-performance.md) records native before/after CPU
and idle evidence on headed Chromium hardware. Cross-package throughput, startup, total memory,
and multiple-terminal qualification remain open.
