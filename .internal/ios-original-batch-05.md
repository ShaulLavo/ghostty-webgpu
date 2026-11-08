# Original browser batch 05

Status is Approved. This batch selects the complete, unchanged
`src/dom/tests/font-geometry.browser.test.ts` file for parent-owned native qualification.
Its three cases exercise loaded font metrics, mounted Canvas geometry and pixel boundaries,
and the pinned ghostty-web Canvas renderer's metrics.

The canonical native registry was reconciled after batch 04. Eleven previously completed
original files stay frozen at their own source-specific receipts. No original in this batch
has native completion credit. Root completion remains false.

The original font helper, real WOFF2, all hooks, cleanup callbacks, assertions, parameter
loops, and timing remain unchanged. The selected file needs no provider screenshot,
input, viewport command, or host extension. Waffle stays pinned at 0.0.111.

The coordinator owns independent review, ready-head CI, merge, main CI, and native scheduling.
The worker neither acquires a native session nor changes the paused event task.

The portable packet is kept at
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch05/resumed/packet/`.
Local qualification and final source bindings are recorded there before handoff.

This replacement recovers cancelled checkpoint `5dd03ca3710bdd9af24d703d78ae1e8e8098a737`
with cherry-pick origin records. PR 95, its branch, bundle, and cancellation records
remain intact. The recovered local gate passed all three originals once in Chromium.
Native execution and review remain separate parent gates.
