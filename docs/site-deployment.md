# Build and deploy the sites

The scene edition at <https://ghostty.shaulavo.dev/> uses the existing Cloudflare Worker `product-sites-ghostty`. The classic edition at <https://shaullavo.github.io/ghostty-webgpu/> uses GitHub Pages. Each edition includes the shared docs and interactive examples.

## Build the custom-domain site

Use Bun 1.4.4 and Node 20 or newer. Run these commands from a clean checkout of the reviewed commit:

```sh
bun install --frozen-lockfile
bun run site:worker:build
bun run site:worker:dry-run
```

The build compiles the terminal, checks the examples, generates the API reference and search index, and writes `site/dist/`. It copies the checked-in WASM files without rebuilding them. The dry run bundles `site/worker/index.ts` into `.artifacts/site-worker/` and validates `wrangler.jsonc` without uploading or deploying.

The config retains the Worker name, custom domain, compatibility date, scene handler, asset binding, and routing rules. The handler selects a scene, sets a session cookie, personalizes HTML, and returns missing pages with status 404. Hashed assets, fonts, scenes, search data, and WASM keep their asset paths. `site/public/_headers` supplies the existing security and immutable-cache headers.

## Check both editions locally

Build the classic edition after building the terminal:

```sh
bun run --cwd packages/line-editor build
bun run --cwd site-classic build
bunx playwright install chromium
bun run sites:verify "$PWD/.artifacts/docs-browser" 4327
```

Choose a free loopback port. The verifier starts one preview at a time, checks docs, echo terminals, mobile layouts, and search, then stops each preview on success or failure. It writes screenshots, preview logs, and verification JSON under the supplied evidence directory. The scene check also covers first-frame sizing, selection, fonts, and nested 404s. Astro preview serves static output; Worker cookie and response-header behavior is covered by `bun test site/worker/index.test.ts` and the post-deploy checks below.

## Switch publishing ownership

Only the coordinator deploys after independent review.

1. Record the current production Worker version before switching source owners. Use the existing account and credentials. Keep the version ID with the deployment receipt.
2. Retain the last known-good source commit and full site artifact. CI's `site-worker` artifact contains `site/dist/`, `.artifacts/site-worker/`, and `wrangler.jsonc`. Record its workflow run ID, source SHA, and archive checksum. GitHub Actions artifacts expire, so download the rollback copy before deploying.
3. Retire Fregat's `ghostty-docs.yml` schedule when this repository's CI schedule is enabled. Retire its `ghostty-config-resolver.yml` and `ghostty-config-resolver-proof.yml` dispatch producers at the same handoff. This PR changes only this repository, so the coordinator owns those removals.
4. Stop using Fregat's `scripts/product-sites/wrangler.ghostty.jsonc` for future deploys. Keep its source and last built output available for rollback. Leave the other product-site Workers unchanged.
5. Build and dry-run the reviewed standalone source, then deploy to the same Worker:

```sh
bunx wrangler versions list --config wrangler.jsonc
bun run site:worker:deploy
```

Wrangler uses your existing Cloudflare authentication or the standard `CLOUDFLARE_API_TOKEN` and account configuration. Do not put credentials in source or artifacts. The build and dry run need no production credentials. This repository has no automatic Cloudflare deployment job.

After deployment, check the actual Worker:

```sh
curl -fsSI https://ghostty.shaulavo.dev/
curl -fsS https://ghostty.shaulavo.dev/ | grep 'data-scene='
curl -fsSI https://ghostty.shaulavo.dev/docs/
curl -fsSI https://ghostty.shaulavo.dev/ghostty-vt.wasm
curl -sS -o /dev/null -w '%{http_code}\n' https://ghostty.shaulavo.dev/missing/deep/
```

Expect personalized HTML with `private, no-store` and a scene cookie, WASM with its correct MIME type, and a 404 for the missing page. Fetch a hashed `/_astro/` asset and a bundled font from the returned HTML and confirm immutable caching. Run `site/scripts/verify-docs.ts` against `https://ghostty.shaulavo.dev/docs/` for the full browser check.

## Roll back

To restore the recorded Cloudflare version, use the same config and account:

```sh
bunx wrangler rollback RECORDED_VERSION_ID --config wrangler.jsonc
```

Recheck the live HTML, docs, assets, and 404 after rollback. Cloudflare code rollback does not restore external resource data. This Worker has only static assets and its scene handler.

For a source rebuild, create a clean worktree at the recorded known-good source commit, install its frozen lockfile, and repeat its build, dry-run, and deploy commands. A pre-switch source commit uses Fregat's recorded product-sites build recipe and config.

For an artifact rollback after Cloudflare's retained versions expire, restore the recorded `site-worker` artifact into a clean directory with its original paths. Install the matching pinned Wrangler from the recorded source lockfile. Deploy the retained bundle and assets together:

```sh
bunx wrangler deploy .artifacts/site-worker/index.js --no-bundle --config wrangler.jsonc --dry-run
bunx wrangler deploy .artifacts/site-worker/index.js --no-bundle --config wrangler.jsonc
```

Do not replace the artifact's `site/dist/` with a newer build. Keep the source commit, bundle, assets, and config from the same run.

## Producer ownership

| Producer                                        | Standalone owner                                                                                     | Trigger and output                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Docs build and browser proof for both editions  | `.github/workflows/ci.yml`, `scripts/verify-sites.sh`, each site's existing `scripts/verify-docs.ts` | Pull requests, main pushes, manual runs, and daily at 03:17 UTC. Uploads `site-worker`, `site`, and `docs-browser`.             |
| Classic Pages publication                       | `.github/workflows/site.yml`                                                                         | Successful main CI from a push or manual run. Consumes `site` without rebuilding. Nightly runs produce evidence only.           |
| Native resolver artifacts and release candidate | `.github/workflows/config-resolver.yml`                                                              | Manual dispatch with exact source and native-input digest. Preserves all four targets and immutable artifact/provenance checks. |
| Native resolver proof                           | `.github/workflows/config-resolver-proof.yml`                                                        | Manual inventory or evidence dispatch with exact source and upstream revision. Preserves all four targets.                      |

The resolver workflows already moved with the standalone release. They have no schedules to port. Their helper scripts already live under `scripts/config-resolver-native/`, `scripts/config-resolver-proof/`, and `scripts/release-candidate/`. Keep one owner for each producer after the coordinator retires the Fregat workflows. The nightly docs work runs in the existing CI job after the package checks, so site builds reuse its compiled packages. It does not publish npm packages or create a release.
