# Plan 016: Make the library ready to replace ghostty-web

Status: **IN PROGRESS**. This is the sole active product milestone, approved on 2026-09-05.
It supersedes the execution program in Plans 009–015. Completed Plans 001–008 remain historical
foundations. This plan does not depend on those old plans reaching full xterm parity.

## Outcome

An independent developer can install the package, migrate a working ghostty-web integration through
a small documented change, and retain the useful terminal behavior their application depends on.
The library provides correct Ghostty behavior, reliable browser rendering and fallbacks, live
customization, and demonstrated improvements over the pinned comparison release.

Platform is a required real consumer fixture, not the product boundary. Include standalone browser
integrations that do not depend on Platform, its configuration, or its build tools.

The ambition is improvement across every user-visible dimension. A release claim must name the
baseline and supported environments, demonstrate the claimed wins, and disclose remaining
limitations. Do not turn an unmeasured comparison into a pass or hide a regression in an average.

## Starting evidence

At implementation commit `d9300af`, WebGPU, WebGL2, and Canvas2D selection and runtime WebGL-to-Canvas2D
recovery exist. Displayed-canvas tests catch missing draws and stale theme updates. The default
Chromium 17-terminal reproduction preserves session, selection, input, and rendering after eviction.
Those results establish useful implementation progress, not complete replacement readiness.

Known work still required:

- The package root uses the asynchronous native `Terminal`; `/xterm` provides the familiar
  synchronous shape. Existing ghostty-web code expects `init`, `Terminal`, and `FitAddon`.
- The compatibility API still throws for useful buffer reads and custom link registration.
  The native implementation already has data and link facilities that should be reused where valid.
- The standard build and package path require native config-resolver artifacts. The browser
  distribution has been compiled directly, but that bypass is not package-release evidence.
- The current Linux Chromium setup fails WebGPU presentation even for a raw clear outside this
  library. Preserve the strict screenshot assertion and obtain evidence in a working environment.
- Existing renderer benchmarks are not a complete comparison against ghostty-web. Historical burst
  CPU failures remain evidence to investigate, not waived results.
- Earlier physical input and VoiceOver acceptance passed at the revision recorded in
  [Phase 3 acceptance](../docs/phase-3-acceptance.md). Reuse applicable evidence and rerun affected
  checks for the candidate release. Browser automation alone does not prove physical input or speech.

## Scope

Required work covers migration, useful baseline APIs, correct terminal behavior, package readiness,
browser quality, and direct comparisons. Keep all three renderers, live theme and transparency
support, native input, selection, scrolling, clipboard, links, accessibility, and resource cleanup.

Do not make these separate ambitions release prerequisites:

- Complete xterm API, DOM, parser interception, Unicode-provider, marker, and official-addon parity.
- A separate headless product or a family of aliasable addon packages.
- Native Ghostty configuration discovery on every host architecture.

Search, serialization, font loading, ligatures, images, and progress are capabilities to evaluate
individually. Existing ghostty-web support or a real consumer dependency can make one required.
Moving an old addon plan out of the execution queue does not excuse losing useful baseline behavior.

Preserve working features. Any proposed deletion must identify the consumer impact and migration,
rather than treating a smaller feature count as an improvement by itself.

## 1. Freeze the comparison and migration contract

- [x] Pin a released ghostty-web package version, integrity hash, matching source revision, and
      public API documentation. Use that immutable baseline throughout the comparison.
- [ ] Record the candidate commit, browser versions, operating systems, hardware adapters, fonts,
      device-pixel ratios, build settings, and package-loading conditions with the results.
- [ ] Create one reproducible consumer fixture runner that can exercise both packages. Start with
      the upstream initialization, fitting, write, input, resize, and disposal example. Add a standalone
      application that uses buffer text reads and custom links, then the real Platform integration.
- [x] Inventory public behavior into a bounded support contract: baseline behavior, consumer need,
      current implementation, migration, evidence, and remaining gap. Include supported browser and
      embedded-host conditions. A throwing placeholder cannot count as supported.
- [ ] Write the mapping for `init`, construction, readiness, `open`, fitting, themes, events, and
      disposal. Choose a compatible entry point or a small explicit migration after exercising the
      fixtures. Do not promise an import-only replacement unless the tests prove it.

Extend existing test and benchmark runners where practical. The result is one replacement
comparison, not a second exhaustive xterm inventory. Pin the evaluation scope before implementing
gaps; do not remove a failing required row to make the final gate pass.

## 2. Make the browser package independently usable

This can proceed alongside the API work after the baseline and fixtures are recorded.

- [x] Decouple browser build, verification, packing, and installation from native config-resolver
      assembly. Keep optional host integration behind its own artifact and availability contract.
- [x] Keep native resolver provenance and artifact validation intact for the host distribution.
      Missing host binaries must not turn browser verification into a misleading native success.
- [x] Build and pack through the normal documented commands. Install the packed artifact into clean
      external consumer directories, outside this checkout and its development dependencies.
- [ ] Exercise browser asset loading, WASM resolution, type declarations, the documented native and
      compatibility imports, CSS, and a representative bundler setup. Confirm that importing the
      browser-safe package in Node does not require DOM globals or host-only resolver code.
- [x] Measure compressed transfer size and installed footprint separately. Report optional host
      assets separately from browser JavaScript and WASM. Do not label dependency count as download size.
- [x] Update public installation and availability statements to match the artifacts actually shipped.

Completion means a standalone consumer can use the documented package without source-build
bypasses or native resolver tooling. Optional host packaging cannot block this browser milestone.

## 3. Close actual consumer gaps

- [ ] Implement and test useful buffer reads required by the pinned baseline and fixtures: line
      access, cell/text extraction, and cursor position. Identify active, inactive, and scrollback
      behavior explicitly. Read authoritative native state; do not substitute rendered viewport rows
      for a buffer API that promises more.
- [ ] Wire custom link-provider registration and disposal through existing native/DOM facilities.
      Test activation, resizing, scrolling, wrapped content, and runtime canvas replacement for the
      supported contract. Keep URL activation and clipboard decisions under host control.
- [ ] Resolve migration gaps exposed by initialization, fitting, writes queued before readiness,
      appearance updates, and disposal. Reuse the existing native implementation and compatibility
      facade instead of maintaining a second terminal model.
- [ ] Evaluate additional baseline capabilities individually and implement the missing ones needed
      by the agreed replacement contract. Full xterm addon replication is not the selection rule.
- [x] Replace plan-number-based public placeholder messages with truthful capability information
      where unsupported APIs remain exposed. Update the public support contract and compatibility
      evidence without promoting unresolved rows.

If a required behavior needs an unavailable public libghostty hook, isolate the missing hook and
pursue an upstream change or an explicit migration that preserves the consumer workflow. Keep
other work moving. That capability remains unresolved until tested; neither a private fork nor a
shadow parser is an acceptable shortcut.

## 4. Qualify behavior and compare the implementations

Exercise both packages with the same inputs and capture the observable results. Ghostty behavior
is the authority where the comparison library has a bug; record the difference and the evidence.

| Dimension                  | Required evidence                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal behavior          | Real shell and representative TUI sessions, scrolling, alternate screen, Unicode and graphemes, wide cells, selection, cursor, resize/reflow, and supported links.                                                            |
| Visual quality             | Displayed screenshots for text and decorations, colors, live theme changes, transparent defaults and explicit backgrounds, fonts, DPI, and resizing. Observation must not submit another terminal draw.                       |
| Browser availability       | Declared Chromium, Firefox, and Safari/WebKit coverage with actual selected backend recorded. Exercise available WebGPU plus forced WebGL2 and Canvas2D paths; WebKit automation alone does not establish every Safari claim. |
| Input and accessibility    | Keyboard, held keys, composition/IME, clipboard, pointer selection, focus, and screen-reader behavior in supported environments. Record physical evidence where automation is insufficient.                                   |
| Startup and responsiveness | Cold load, time to first visible output, input-to-display latency, burst output, and sustained scrolling. Report distributions and identical processed output.                                                                |
| Resource use               | Renderer and GPU CPU, native/WASM memory, observable GPU/process memory, and cleanup after disposal. Distinguish measurements from estimates and unavailable metrics.                                                         |
| Multiple terminals         | One, eight, and seventeen terminals, visible and hidden, active and idle; open/close cycles, context eviction, recovery, continued input, and memory retention.                                                               |
| Idle behavior              | A settled terminal with cursor animation disabled has no standing frame loop or maintenance timer. Active cursor transitions remain bounded and stop when ineligible.                                                         |
| Integration                | Clean packed consumers, fitting, live options, buffer reads, custom links, and Platform without consumer-specific workarounds in the library.                                                                                 |

Use `bun run bench:renderer` as the starting point for renderer measurements. Extend it to run the
comparison package and report the whole relevant browser workload, not only the GPU process.
Performance evidence requires headed Chromium on a hardware adapter. Keep device, browser,
viewport, font, workload, warmup, and sample protocol comparable. Run at least three repetitions,
alternate package order, retain raw samples, and report medians and tail behavior.

Set measurement tolerances from repeatability before judging the results. Require no material
regressions outside those tolerances in the agreed comparison dimensions, plus measured wins in the original pain
points: theme/transparency reliability and unnecessary rendering/resource use. A faster scene does
not excuse lost text, broken input, worse browser coverage, or a material memory regression.
Explaining a failed threshold does not make it pass.

A broken test environment is an unverified result. Fix the environment or obtain an equivalent
supported environment; do not turn off a required visual assertion. Recheck historical performance
failures with comparable measurements and record any justified methodology change. Old plan
retirement alone does not resolve a failure.

## 5. Decide readiness from the artifacts

- [ ] The pinned support contract has no unresolved required consumer workflow or API gap.
- [ ] Clean packed-consumer migration passes through the documented path.
- [ ] Normal browser build, package checks, and the applicable automated test suites pass.
- [ ] Current displayed-output evidence covers each supported renderer and declared browser path.
- [ ] Applicable physical input and accessibility evidence is recorded for the release candidate.
- [ ] Comparison results meet the predeclared tolerances, show the claimed improvements, and report
      resource use, startup, visual behavior, and multiple-terminal results without hidden regressions.
- [ ] Remaining optional capabilities and intentional behavior differences are documented accurately.
- [ ] Public claims name the tested baseline and environments. Unsupported features and missing
      measurements keep the relevant claim qualified; full xterm certification is not required.

Until these checks pass, describe the product as a preview. Completing the milestone establishes
readiness against this contract; it does not automatically publish or tag a release.

## Existing checks and evidence to reuse

Run checks appropriate to each change, then the complete candidate validation after integration:
`bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test:unit`,
`bun run test:renderer-fallbacks`, `bun run test:renderer-smoke`, `bun run test:xterm-browsers`,
`bun run xterm:parity`, `bun run build`, and `bun run test:package`. Run displayed-package checks
after building the candidate distribution. The current native build gate must be decoupled in step
2 before these commands can establish browser package readiness without native artifacts.

The new packed-consumer comparison and hardware runs supplement those commands. Preserve the
[xterm ledger](../docs/xterm-parity.md), [physical acceptance](../docs/phase-3-acceptance.md), and
[renderer baseline](../docs/renderer-refactor-baseline.md) as evidence with their original scope.
The ledger's historical owner plan numbers and remaining xterm gaps do not reinstate Plans 009–015
as release gates.

## Implementation record, 2026-09-05

The [initial support contract](../docs/replacement/README.md) and immutable baseline metadata are
recorded. `test:replacement` exercises both released ghostty-web 0.4.0 and the built candidate.
It records failures for buffer reads, fitting and compatibility link registration. The fixture is
not yet a complete standalone application or the real Platform integration, so those checklist
items remain open. Platform still imports the old native class name at its recorded revision.

Normal build and browser verification no longer require native resolver assembly. `test:package`
checks an external packed browser consumer, including displayed Canvas2D output. The existing
strict host package test remains under `test:package:host`; `build:host` and `verify:host` require
assembled artifact validation. Package measurements report bundled JavaScript and each WASM asset separately, plus installed
package, dependency and optional native bytes. The full comparison remains unfinished.
Public placeholder messages describe unsupported capabilities without referring to historical
plan numbers. The xterm ledger retains unresolved status.

Validation for this working tree: typecheck, lint, formatting, all 353 unit tests, all 43 renderer
fallback tests, xterm ledger validation, normal build and clean browser package smoke pass.
Chromium and Firefox compatibility suites pass. WebKit cannot launch because the host lacks
libicu74, libxml2 and libflite1. Strict WebGPU presentation still fails with zero displayed red
pixels; separate WebGL2 and Canvas2D presentation passes. These are unresolved environment results.

The initial comparison reproduces a baseline live-theme failure, with 334 red pixels remaining
and no green pixels after changing the foreground. The candidate passes that probe but fails its
three API probes. This one Canvas2D result is not a general superiority claim. Raw comparison
results and screenshots are under `.artifacts/replacement/`; packed-consumer size evidence is
under `.artifacts/package-browser.json`. A later package check used npm's cached registry data
after registry connections returned ENETUNREACH; the consumer still installed into a new external
directory. No physical input, hardware performance or real Platform acceptance was completed.

### Renderer performance follow-up

The [renderer performance record](../docs/replacement/renderer-performance.md) adds 90 paired
hardware samples across Canvas2D, WebGL2, and WebGPU. Cursor-update CPU falls 67–72%; Canvas2D
burst and scroll CPU fall 12% and 9% on the measured Linux NVIDIA system. All native idle samples
request zero frames. The exploratory ghostty-web 0.4.0 comparison requests 121 idle frames in two
seconds; different cell sizes prevent a general cross-package throughput claim.

Headed Wayland fixes the earlier environment's missing WebGPU presentation. The built package
displays and recolors text on all three backends with `GHOSTTY_BROWSER_HARDWARE=1`; default
software-rendered checks remain separate. Existing decoration, alpha rounding, and screenshot
dimension assertions still fail in their recorded environments. The renderer changes do not
complete the API, integration, physical input, startup, memory, or multiple-terminal contract.
