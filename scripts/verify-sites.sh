#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
evidence=${1:?Usage: verify-sites.sh EVIDENCE_DIRECTORY PORT}
port=${2:?Usage: verify-sites.sh EVIDENCE_DIRECTORY PORT}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd)

has_setsid=0
if command -v setsid >/dev/null 2>&1; then
  has_setsid=1
fi

declare -a child_pids=()
cleaned=0
started_pid=''

signal_child() {
  local pid=$1
  local sig=$2
  if [[ "$has_setsid" == 1 ]]; then
    kill "-$sig" -- "-$pid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
    return
  fi
  kill "-$sig" "$pid" 2>/dev/null || true
}

cleanup() {
  if [[ "$cleaned" == 1 ]]; then return; fi
  cleaned=1
  local pid
  for pid in ${child_pids[@]+"${child_pids[@]}"}; do
    signal_child "$pid" TERM
  done
  for pid in ${child_pids[@]+"${child_pids[@]}"}; do
    wait "$pid" 2>/dev/null || true
  done
  child_pids=()
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

start_preview() {
  local site=$1
  local site_port=$2
  local base=$3
  mkdir -p "$evidence/$site"
  if [[ "$has_setsid" == 1 ]]; then
    (cd "$root/$site" && exec setsid bun node_modules/.bin/astro preview --ignore-lock --base "$base" --host 127.0.0.1 --port "$site_port" >"$evidence/$site/preview.log" 2>&1) &
  else
    (cd "$root/$site" && exec bun node_modules/.bin/astro preview --ignore-lock --base "$base" --host 127.0.0.1 --port "$site_port" >"$evidence/$site/preview.log" 2>&1) &
  fi
  started_pid=$!
  child_pids+=("$started_pid")
}

wait_for_preview() {
  local site=$1
  local site_port=$2
  local base=$3
  local pid=$4
  local log="$evidence/$site/preview.log"
  local expected="http://127.0.0.1:$site_port$base"
  local ready=0
  for _attempt in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$log"
      exit 1
    fi
    if grep -Fq "$expected" "$log" && curl --fail --silent "http://127.0.0.1:$site_port${base}docs/" >/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    cat "$log"
    exit 1
  fi
}

site_port=$port
classic_port=$((port + 1))

start_preview site "$site_port" /
site_preview=$started_pid

start_preview site-classic "$classic_port" /ghostty-webgpu/
classic_preview=$started_pid

wait_for_preview site "$site_port" / "$site_preview"
wait_for_preview site-classic "$classic_port" /ghostty-webgpu/ "$classic_preview"

if [[ "$has_setsid" == 1 ]]; then
  (cd "$root/site" && exec setsid bun scripts/verify-docs.ts "http://127.0.0.1:$site_port/docs/" "$evidence/site") &
else
  (cd "$root/site" && exec bun scripts/verify-docs.ts "http://127.0.0.1:$site_port/docs/" "$evidence/site") &
fi
site_verify=$!
child_pids+=("$site_verify")

if [[ "$has_setsid" == 1 ]]; then
  (cd "$root/site-classic" && exec setsid bun scripts/verify-docs.ts "http://127.0.0.1:$classic_port/ghostty-webgpu/docs/" "$evidence/site-classic") &
else
  (cd "$root/site-classic" && exec bun scripts/verify-docs.ts "http://127.0.0.1:$classic_port/ghostty-webgpu/docs/" "$evidence/site-classic") &
fi
classic_verify=$!
child_pids+=("$classic_verify")

status=0
wait "$site_verify" || status=$?
wait "$classic_verify" || status=$?
cleanup
exit "$status"
