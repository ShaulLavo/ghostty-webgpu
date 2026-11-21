#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
evidence=${1:?Usage: verify-sites.sh EVIDENCE_DIRECTORY PORT}
port=${2:?Usage: verify-sites.sh EVIDENCE_DIRECTORY PORT}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd)

declare -a pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  pids=()
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verify_site() {
  local site=$1
  local site_port=$2
  local base=/
  if [[ "$site" == site-classic ]]; then base=/ghostty-webgpu/; fi
  mkdir -p "$evidence/$site"
  node --input-type=module -e 'import { createServer } from "node:net"; const server = createServer(); server.listen({host: "127.0.0.1", port: Number(process.argv[1])}, () => server.close())' "$site_port"
  cd "$root/$site"
  bun node_modules/.bin/astro preview --ignore-lock --base "$base" --host 127.0.0.1 --port "$site_port" \
    > "$evidence/$site/preview.log" 2>&1 &
  local preview=$!
  trap 'kill "$preview" 2>/dev/null || true; wait "$preview" 2>/dev/null || true' EXIT INT TERM
  local ready=0
  for _attempt in $(seq 1 60); do
    kill -0 "$preview" || { cat "$evidence/$site/preview.log"; exit 1; }
    if curl --fail --silent "http://127.0.0.1:$site_port${base}docs/" > /dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || { cat "$evidence/$site/preview.log"; exit 1; }
  bun scripts/verify-docs.ts "http://127.0.0.1:$site_port${base}docs/" "$evidence/$site"
}

verify_site site "$port" &
site_pid=$!
pids+=("$site_pid")

verify_site site-classic "$((port + 1))" &
classic_pid=$!
pids+=("$classic_pid")

status=0
wait "$site_pid" || status=$?
wait "$classic_pid" || status=$?
cleanup
exit "$status"
