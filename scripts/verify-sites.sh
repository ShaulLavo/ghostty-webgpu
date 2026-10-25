#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
evidence=${1:?Usage: verify-sites.sh EVIDENCE_DIRECTORY PORT}
port=${2:?Usage: verify-sites.sh EVIDENCE_DIRECTORY PORT}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd)
preview=''
cleanup() {
  if [[ -z "$preview" ]]; then return; fi
  kill "$preview" 2>/dev/null || true
  wait "$preview" 2>/dev/null || true
  preview=''
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for site in site site-classic; do
  base=/
  if [[ "$site" == site-classic ]]; then base=/ghostty-webgpu/; fi
  mkdir -p "$evidence/$site"
  node --input-type=module -e 'import { createServer } from "node:net"; const server = createServer(); server.listen({host: "127.0.0.1", port: Number(process.argv[1])}, () => server.close())' "$port"
  cd "$root/$site"
  bun node_modules/.bin/astro preview --ignore-lock --base "$base" --host 127.0.0.1 --port "$port" \
    > "$evidence/$site/preview.log" 2>&1 &
  preview=$!
  ready=0
  for _attempt in $(seq 1 60); do
    kill -0 "$preview" || { cat "$evidence/$site/preview.log"; exit 1; }
    if curl --fail --silent "http://127.0.0.1:$port${base}docs/" > /dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || { cat "$evidence/$site/preview.log"; exit 1; }
  bun scripts/verify-docs.ts "http://127.0.0.1:$port${base}docs/" "$evidence/$site"
  cleanup
done
