# Benchmark data

These directories hold measurement data, not user documentation. Tests read them by path.

- `2026-11-24/` is the data behind the November comparison with xterm.js, ghostty-web, Wraith and Restty in [benchmarks.md](../benchmarks.md).
- `mac-m1-2026-10-10/` is the data behind the October Mac energy pairs in [benchmarks.md](../benchmarks.md) and the overview. Its `report.mjs` writes the whole page. Its own README explains the method and how to recompute the tables.
- `mac-m1-2026-10-08/` is the earlier set. `site/src/measurements.test.ts` still verifies it.

Read [benchmarks.md](../benchmarks.md) for results.
