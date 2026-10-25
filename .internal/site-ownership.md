# Standalone site ownership receipt

Status: source implemented, draft review pending. No deployment or merge.

## Scope

Base: `b54f15f2`, the merged standalone release `v0.3.24-b54f15f2`.

- Copied the native Worker configuration from Fregat's `scripts/product-sites/wrangler.ghostty.jsonc`. Only its schema, handler, and asset-directory paths changed. The Worker remains `product-sites-ghostty` on `ghostty.shaulavo.dev`, compatibility date `2026-10-10`.
- Copied `scripts/product-sites/_headers` byte for byte into `site/public/_headers`.
- The handler in `site/worker/index.ts`, terminal source, WASM, package versions, and config-resolver producer workflows are unchanged.
- Added the existing daily `17 3 * * *` docs schedule to CI. Both editions build after the package checks and reuse their outputs. Pages still consumes the classic artifact only after a successful main push or manual CI run. Scheduled runs produce evidence without publishing.
- `scripts/verify-sites.sh` owns each preview PID and stops it on success, failure, or signals. `--ignore-lock` keeps Astro 7's agent-detected preview in the foreground.
- Regenerated the native source-input closure and bootstrap digest. The sole changed owned-file entry is `.github/workflows/ci.yml`.

## Producer comparison

Fregat is a read-only reference. No Fregat files were edited.

- `ghostty-config-resolver.yml` and standalone `config-resolver.yml` are identical after removing the monorepo working-directory defaults and converting package-source, native-source, and package-relative paths. All four targets, pins, native rebuilds, release-candidate jobs, and provenance checks remain. There is no schedule in either file.
- `ghostty-config-resolver-proof.yml` and standalone `config-resolver-proof.yml` are identical after the package-path conversion and the dispatch input's repository description. All four inventory/evidence targets remain. There is no schedule in either file.
- The `config-resolver-native` and `config-resolver-proof` helper trees already exist in standalone. Their executable source matches the reference. The native-input closure carries the standalone CI ownership digest.
- The docs verifiers already exist in both standalone sites. They launch Chromium. The old workflow's WebKit installation did not run a WebKit check, so CI keeps its existing Chromium installation.
- The coordinator must retire the three Fregat producers and its Ghostty product-site deployment entry during switch-over. This source PR cannot disable those duplicate producers in another repository.

## Verification

All substantial local work ran through the installed shared heavy runner.

Passed:

- `bun install --frozen-lockfile`.
- `bun run site:worker:build`. Scene site built 232 pages, checked 17 authored docs pages, one README fence, six migration snippets, and seven PTY/Worker tests.
- `bun run site:worker:dry-run`. Wrangler 4.149.0 read 1003 asset files, bundled 2.99 KiB of Worker code, and reported only the `ASSETS` binding. No upload.
- `bun run --cwd packages/line-editor build && bun run --cwd site-classic build`. Classic site built 232 pages with valid internal links.
- `bun run sites:verify "$PWD/.artifacts/docs-browser" 4327`. Scene docs at widths 1440, 390, and 320. Classic docs at 1440 and 390. Each checked eight docs paths, echo input, and search. Both verification JSON files report zero page errors. Read back the scene mobile-docs and classic landing screenshots.
- Local `wrangler dev --local --ip 127.0.0.1 --port 4331 --inspector-port 0`. HTTP assertions passed for scene cookie, private HTML, scene retention on docs, nested 404, both byte-identical WASM files and MIME types, immutable hashed-asset caching, and security headers.
- `bunx wrangler deploy .artifacts/site-worker/index.js --no-bundle --config wrangler.jsonc --dry-run --outdir .artifacts/site-worker-rollback`. Retained-bundle rollback packaging passed without upload.
- Ran `sites:verify` with an intentionally missing browser payload. It failed as expected, and the preview port could immediately be bound again.
- `bun run config-resolver:bootstrap && bun run verify:config-resolver-state --state bootstrap`.
- `bun scripts/config-resolver-native/self-test.ts`. 26 passed and 21 invalid cases rejected.
- `bun scripts/config-resolver-proof/proof-self-test.ts --recipe scripts/config-resolver-proof/proof-recipe.json`. PASS.
- `bun run lint`, `bun run format:check`, ShellCheck 0.11.0, `bash -n scripts/verify-sites.sh`, and `git diff --check`. Lint reports existing warnings outside the changed files.
- Parsed CI YAML and checked every external Actions reference for a full 40-character SHA.

Initial preview checks exposed Astro's auto-background behavior. The final helper uses `--ignore-lock`, and both final browser checks passed. A first native proof command used the wrong filename, followed by a missing required recipe argument. The corrected command above passed.

Not run: full unrelated terminal/browser suite, remote native builds, live production checks, or any deployment. Independent review and remote CI belong to the coordinator.

The public runbook is [site deployment](../docs/site-deployment.md). It covers build, dry run, source and artifact rollback, and the coordinator's switch-over steps.

## Packed Canvas qualification

The adjacent packed-browser check now requires and measures `canvas-compose.wasm`, and the renderer smoke serves it with the other two WASM assets. The packed consumer exercises both main-thread Canvas paint modes. The explicit `canvas2d-pixels` scenario must fetch the compositor once, display red glyphs, repaint them green, preserve selection, and dispose its canvas. Opening retains the existing 15-second timeout.

Before the fix, `bun scripts/package-smoke.ts --browser --tarball "$MISSING_TARBALL"` passed with `canvas-compose.wasm` removed. Adding the pixels scenario before allowing its asset failed with `GhosttyError: Canvas pixel composition is unavailable`.

After the fix, the following checks passed through the browser queue with relocated npm installs of the actual packed output:

- `bun scripts/package-smoke.ts --browser --tarball "$VALID_TARBALL"`. Both Canvas modes passed. The measurement JSON contains all three WASM assets.
- The same command with the missing-asset fixture failed with `packed package is missing .../canvas-compose.wasm`.
- The same command with invalid bytes in the compositor asset failed with `Canvas pixel composition is unavailable`.
- `bun run test:renderer-smoke`. WebGPU, WebGL2, Canvas fill-text, and Canvas pixels passed visible glyphs, theme repaint, selection, and disposal.
- `bun run typecheck` and `bunx oxlint scripts/package-smoke.ts scripts/renderer-fallback-smoke.ts` passed.

The fixtures used the same `createTarball` helper as the package check. Each negative fixture changed only the compositor asset. No runtime source, exported API, version, or WASM bytes changed. Temporary installed consumers clean themselves in `finally`; the fixture copies and tarballs are disposable after verification.
