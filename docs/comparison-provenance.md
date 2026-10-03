# Comparison runtime provenance

Build both bundles with the same benchmark checkout and select the measured runtime independently.

```sh
bun scripts/build-comparison.ts <baseline-bundle> --runtime-ref <baseline-ref>
bun scripts/build-comparison.ts <treatment-bundle>
```

`--runtime-ref` resolves a commit once. The builder archives one runtime snapshot from that commit containing `src/`, `bridge.wasm`, `ghostty-vt.wasm` and `package.json`. Runtime imports resolve into the archive. The bundle copies `bridge.wasm` and `native.wasm` from the archive and reads the library version from its package metadata. The archive stays alive through asset copying and manifest generation, then is removed even if the build fails.

Without `--runtime-ref`, these inputs come from the current checkout, including dirty files. The builder checks their inventory again before writing the manifest. Changing a runtime input during the build fails the build.

## Manifest fields

- `runtime.mode`, `runtime.ref` and `runtime.commit` identify the runtime selection. An archived runtime has an empty `runtime.dirty` value. Checkout dirtiness covers all snapshot inputs.
- `runtime.version` and `versions["ghostty-webgpu"]` contain the selected snapshot's package version.
- `runtime.files` maps each snapshot path to the SHA-256 of its bytes. It includes package metadata and both WASM files alongside runtime source files.
- `runtime.sourceSha256` hashes the complete snapshot inventory. The format is sorted relative path, NUL, file bytes, NUL for each file.
- `assets["bridge.wasm"]` and `assets["native.wasm"]` hash the copied bundle assets. They match the snapshot hashes for `bridge.wasm` and `ghostty-vt.wasm` respectively.
- `benchmark` identifies the current benchmark checkout. Counterpart libraries, fonts, benchmark fixtures and runner scripts also come from that checkout. Their asset hashes and dependency versions remain separate from runtime provenance.
- `bundleSha256` hashes the generated browser bundle. `sourceSha256` combines the runtime and benchmark inventory hashes using the format recorded in `sourceHashFormat`.

A missing revision or required snapshot path fails the build. There is no fallback to current assets or a different revision. Git, archive and assertion failures use the comparison builder's existing command-error contracts.

## Existing evidence

Earlier archived bundles recorded source-only runtime inventories and could contain current-checkout WASM assets and version labels. Their recorded timing results remain unchanged. Evidence that manually corrected those assets retains its original correction notes. This provenance repair makes no performance claim and does not validate historical bundles retroactively.

## Regression check

```sh
bun test ./bench/comparison-build*.test.mjs
```

The CLI test creates a local Git repository under the OS temporary directory. Its baseline and treatment differ in source, both WASM assets and package version. It checks archived bundle bytes against Git blobs, recalculates every runtime file hash and the inventory hash, checks checkout builds with a dirty asset, and verifies cleanup after missing-input and build failures. The fixture uses the installed comparison dependencies and never runs a provider or renderer.
