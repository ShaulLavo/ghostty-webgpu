# Text pass original preparation

Status: Approved, batch 54 source preparation. Parent owns independent review,
required CI, merge, green main, and native intake. Native hold is unchanged.

The sole original is `src/render/tests/text-pass.browser.test.ts`, blob
`4630395e912a7be748972dc7af0f5acd69aa479e`, at base
`003f2a1a609e099a6963d133792e6b79070f8fb2`. The `text-pass` stage binds all nine
cases at 15,000 ms and zero retries. Both packed binding-budget rows remain,
including `Math.floor(134217728 / 80)`. Default device limit 134217728, all native
frame building, GPU allocations, original rasterizers, uploads, readbacks, pixel
oracles, regional inputs, and duplicate cleanup remain byte-identical.

The complete static graph has 56 local modules and the eager runtime graph has 44. The native runtime requests root `ghostty-vt.wasm` and `bridge.wasm`.
No external font or Worker is requested. Font measurement uses actual OS
monospace fitted to 16px cells. No unsupported provider operation or incompatible
original clock is required. Waffle remains published 0.0.111.

All nine original cases passed in exactly one ordinary desktop invocation.
The trailing checker then rejected one parameter title because the initial
manifest missed Vitest's default 40-character string truncation. The corrected
metadata uses `binds the largest grid in the packed binding budg… on default
device limits`. Installed formatter source and a nonexecuting formatter control
prove that expansion. The raw result, old manifest, driver, and exit status are
preserved. Saved-data checks validate the correction without original replay.

Pre-entry gates passed root and both extension builds, types, 33 explicitly
listed normally discovered safe metadata files with 151 tests, lint, oxfmt,
docs/help, and strict copied-driver types. The repaired metadata passes the same
nonexecuting gates. The local evidence and packet are under
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch54/`.
The worker does not claim native completion or alter any fixed exclusion.
