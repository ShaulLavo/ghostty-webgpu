# Release built packages

1. Run `bun install --frozen-lockfile` and `bunx playwright install --with-deps chromium`.
2. Run `bun run verify`. This builds and checks the terminal, line editor, and shader addon, then packs them into `.artifacts/`. The terminal tarball is checked in Chromium. All three final tarballs are installed together in a temporary npm consumer to check their declarations together, addon exports, and behavior.
3. Inspect `.artifacts/ghostty-webgpu.tgz`, `.artifacts/ghostty-webgpu-line-editor.tgz`, and `.artifacts/ghostty-webgpu-shaders.tgz`. The accompanying `release.json` records the source commit, package names, versions, and SHA-256 checksums. Keep these files unchanged after verification.
4. When cutting a version, update the affected patch versions and changelogs. Update addon peer ranges if the terminal version requires it. Commit those changes and repeat verification.
5. Tag the reviewed commit with `v<terminal-version>-<short-commit>`, using 7 to 40 lowercase commit characters, then push the tag. The CI workflow verifies the source and validates the tag version, commit prefix, tag target, and downloaded package checksums before creating a draft GitHub release containing the tested tarballs and manifest. Publish that draft after reviewing it.
6. Consumers pin each package's release asset URL. See [installation](use-in-your-app.md#install-a-release).

The workflow uses the repository's GitHub token. Publishing to npm requires separate credentials and is optional. No package is published by a pull request.

`bun run pack:release` packs existing build output without rebuilding it. `bun run test:package:built` validates the manifest and checks the same three tarballs without repacking. To repeat the production npm configuration check, run `NODE_ENV=production npm_config_omit=dev bun run test:package:built`.

## Native config resolver

The checked-in native resolver is classified by `bun run verify:config-resolver-state --state either`. In `bootstrap` state, the browser terminal is ready to distribute and native resolver helpers still need assembly. The existing config-resolver artifact workflow builds all four native targets and checks a release candidate before host distribution. In `assembled` state, CI checks the host entry from the same tarball.

Preserve the pinned Ghostty source and native proof contracts. A source-only tarball supports the browser terminal, worker, and wasm exports. See [config resolver](config-resolver.md) for the host API and artifact requirements.
