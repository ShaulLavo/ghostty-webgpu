# Native registration refresh for PR 134

The capability edits changed 14 complete browser-source identities. Their native
manifests and independent location expectations now match snapshot
`3e46eecf627ad5d42dbfd4ac558c033f66a248af`.

Every existing case keeps its name, order, timeout, retry count and other metadata.
The selector original adds one fallback case, so its complete manifest grows from
49 to 50. Its regression expectations retain all 49 existing rows and explicitly
check the added case. No fixed exclusions, original assertions, SDK pins,
production files or helper implementations change.

The new source-key regression checks every native stage against its complete
source hash and verifies that each location points to an original registration.
The native import control creates the maintained Safari Vitest configuration with
the actual attached provider and framework plugin, transforms both capability
helpers and the PNG decoder, and verifies the browser Vitest TestRunner export.
It closes the Vite context and checks listener and document-hook cleanup. It never
starts a native session or executes a native browser body.

Validation on the PC heavy runner:

- Before the fix, 28 tests failed and 248 passed across the native-path Node suite,
  excluding the separately maintained browser controls.
- After the fix, 297 tests passed in 53 files, including the maintained Chromium
  and no-browser controls and capability/PNG unit tests.
- After the final source-key regression and selector assertions, the three
  affected files passed all 15 tests.
- Package build, line-editor build, typecheck, format check and lint passed.
  Lint retains existing warnings outside this change.
- A separate comparison confirms that all existing manifest metadata remains
  identical except for source-key locations. All 45 source hashes verify.

Commands and logs are retained in
`/work/reports/goals/ghostty-shell-20261114/native-registrations`.
These are Node, Vite and labelled desktop controls. They provide no native Safari,
Mac, iPhone or whole-root browser-suite qualification.
