#!/usr/bin/env bash
set -euo pipefail
compiler=$(mktemp -d)
trap 'rm -rf -- "$compiler"' EXIT
mkdir attribution-check
cp scripts/*.zig attribution-check/
bun .internal/compact-record-attribution/generate.ts "$PWD" "$PWD/attribution-check"
curl -fLsS https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz | tar -xJ -C "$compiler" --strip-components=1
for variant in extracted timed; do
  "$compiler/zig" build-exe "attribution-check/$variant.zig" -target wasm32-freestanding -fno-entry -rdynamic --import-memory --export=__stack_pointer --stack 65536 -I "$BOAT_INPUT_HEADERS" -O ReleaseSmall -femit-bin="$compiler/$variant.wasm" >"attribution-check/build-$variant.log" 2>&1
done
G5_REPO="$PWD" G5_SCRATCH="$PWD/attribution-check" G5_OUTPUT="$PWD/attribution-check" bun .internal/compact-record-attribution/check.ts
