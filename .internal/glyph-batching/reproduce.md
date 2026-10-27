# Reproduce X2

Create two exclusive worktrees at `cb607d878`, install with `bun install --frozen-lockfile`, and apply `prototype.patch` only to the candidate. Apply `measurement.patch` only to the candidate too. The existing runner builds both browser bundles from the candidate's measurement entry, resolving production imports against each arm's source root. Never apply the patches to a shared checkout.

Run from the candidate on the PC through the quiet queue:

```sh
bun /work/platform-production/heavy/current/run.js --class bench --quiet 'X2 replay' -- bash .internal/glyph-batching/run-pairs.sh "$candidate" "$baseline" "$output/pc"
```

The PC script checks VRAM before every DPR cohort and also runs an ASCII-warmup cohort under `pc-warm`. Each runner invocation owns and closes its browser. It routes pages internally without starting a dev server.

On the Mac, take the shared lock, check owner availability and AC power, and run the same script with output ending in `/mac`. Run a second time with `BENCH_ASCII_WARMUP=1` and output ending in `/mac-warm`. Copy the JSON, screenshots and logs back, then delete the task's staged source, dependencies and results on the Mac. Preserve other agents' locks and browsers.

Run the focused tests against the prototype:

```sh
bun run test:browser src/render/shared/atlas/canvas-rasterizer.browser.test.ts
```

Use `GHOSTTY_BROWSER_HARDWARE=1` for headed correctness on hardware. On the PC this command also goes through the browser queue. Headless SwiftShader results are correctness evidence only.

Analyze the committed primary receipts with `node .internal/glyph-batching/analyze.mjs`. To analyze the retained raw cohort files instead, use:

```sh
node .internal/glyph-batching/analyze.mjs /work/reports/ghostty-webgpu-next-2026-10/x2
```

The analyzer requires all 48 primary pairs, checks input/text and callback counts, reports atlas/screen equality, and evaluates the existing 40% gate. It does not infer physical presentation from callbacks.
