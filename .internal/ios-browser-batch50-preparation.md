# Batch 50 shared-atlas preparation

Status: Prepared for parent review. No native completion credit.

The `shared-atlas` stage selects the unchanged complete original at
`src/render/tests/shared-atlas.browser.test.ts`, Git blob
`4152c3a6ee20d2d91b347149dadce93b1ed8c348`. Its 16 cases comprise nine single
registrations and seven rows from three `it.each` registrations.
All retain the original 15,000 ms browser case clock, 30,000 ms hook clock,
zero retries, real 50 ms cleanup delay and default `vi.waitFor` polling.

The original FakeClock and FakeRenderState stay intact. The latter attaches an
actual native frame builder through GhosttyRuntime and both real Wasm assets.
The GPU devices, atlas identities, OS glyph rasterization, readback, deferred
texture destruction, encoded owner settlement, allocation failure and real
device loss assertions are unchanged. No screenshots, explicit viewport
operations, font fetches or worker execution are required.

Before original entry, root and extension builds, types, 31 explicitly named
safe adapter files with 143 tests, lint, formatting, docs, launcher help and
strict copied-driver types passed. The one complete desktop execution passed
all 16 cases in headless Chromium with SwiftShader. This proves correctness
only, not hardware performance or Safari qualification.

The report packet is under
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch50/`.
It includes source-derived cases, exact response and build graphs, immutable
maps, saved desktop evidence, source bundle and patch, read-only verification,
and checked cleanup. A trailing saved-data verifier URL assumption was repaired
without replaying the original.

Published Waffle remains 0.0.111. Fixed membership remains 35 touch and 16 N/A.
Other claims, failed attempts and accepted boundaries remain frozen. No original,
helper, provider, runtime, package pin, clock, assertion or exclusion changed.
Parent owns independent review, CI, merge, clean source retirement after T3 cwd
holders release, and any later native intake or execution.
