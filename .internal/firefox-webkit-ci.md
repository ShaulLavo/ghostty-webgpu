# Firefox and WebKit CI

Status: Approved. The coordinator owns independent review, hosted CI, and merge.

The browser test matrix runs Chromium, Firefox, and WebKit across four shards each.
Every engine uses the existing browser test entry point and verified build artifact.
There are no package builds in the browser jobs. The sites job still runs beside
the browser tests and uses its existing Chromium verification.

The four protected `browser (N/4)` names are now gates over the complete test
matrix. They run with `always()` for ready PRs and accept only successful `verify`
and `browser-tests` results. A failure, cancellation, or skipped dependency fails
the gates. Documentation-only PRs retain the existing no-op browser path after
successful verification. Tag releases retain `needs: [verify, browser, sites]`
and publish draft releases from the tested tarballs. Branch protection is unchanged.

## Dependency and cache evidence

The image remains pinned to the Playwright 1.63.0 Noble amd64 digest, matching the
locked package. Each matrix job passes its engine to dependency planning and
browser installation, then to Vitest through `GHOSTTY_BROWSER_ENGINE`.
`install-deps --dry-run` checks the package plan, not installed library presence.
Actual installation and browser launch must validate the image at runtime.

[Main run 43414034916](https://github.com/ShaulLavo/ghostty-webgpu/actions/runs/43414034916)
shows `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, supplied by the image. All four
Chromium shards and the sites job report `Dependency cache hit=true` for the
existing Bun/npm cache key. The unused `~/.cache/ms-playwright` path is removed
from cache configuration. The image already supplies browser payloads, so caching
them again would duplicate storage. The cache key stays unchanged to reuse the
working JavaScript download cache.

## Validation

`bun test scripts/ci-workflow.test.ts` checks engine coverage, build artifact reuse,
the pinned image contract, protected names, and release dependencies. It executes
the actual gate shell for all 16 pairs of dependency states, including skipped and
cancelled dependencies. The workflow runs this check before building packages.

Local checks use the PC heavy runner with teardown installed before dependency
setup. They cover the focused tests, TypeScript, lint, formatting, actionlint with
ShellCheck, and the regenerated native input closure. Updating the workflow changes
one fingerprinted native input, so its generated manifest and bootstrap digest
must change too. No terminal source, browser fixture, or package version changes.

Hosted CI must still prove all 12 engine/shard jobs execute their tests against the
downloaded build, validate the Linux image dependencies, and report real cache
results. The independent Firefox and Linux WebKit workers own product/test fixes.
No full local browser suite, native run, public deployment, or release was run here.

The first hosted Firefox run stopped before collecting tests because the root
container process inherited `/github/home` owned by `pwuser`. Browser setup now
aligns that existing directory's ownership with the process user before installing
dependencies. It does not change the home path or recursively change its contents.
The hosted Firefox and WebKit logs both confirm JavaScript dependency cache hits
and browser payload reuse from `/ms-playwright`.
