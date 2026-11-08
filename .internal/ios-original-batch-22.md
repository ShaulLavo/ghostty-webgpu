# Complete output timing original

Status: Approved source preparation. The parent owns independent review, CI acceptance,
merge and native intake. This batch selects only `src/dom/tests/output-timing.browser.test.ts`
as `output-timing`. All four renderer and presentation rows, four main-terminal lifecycle
cases and the worker case remain unchanged, with their real waits and payload assertions.

The complete source, built worker and installed graph was inspected against published
Waffle 0.0.111 before implementation. No required rejected provider operation or declared
clock conflict was found. This is not Safari qualification or root-suite completion.

Evidence is retained under
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch22/`.
