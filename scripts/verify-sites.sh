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

GHOSTTY_SITES_RUN_ID="$$-$(date +%s%N)-$RANDOM"
export GHOSTTY_SITES_RUN_ID

declare -a child_pids=()
declare -a tracked_pids=()
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

find_tagged_pids() {
  [[ -d /proc ]] || return 0
  local env_file pid
  while IFS= read -r env_file; do
    pid=${env_file#/proc/}
    pid=${pid%/environ}
    if [[ "$pid" == "$$" || "$pid" == "$BASHPID" ]]; then continue; fi
    printf '%s\n' "$pid"
  done < <(grep -Fxlza "GHOSTTY_SITES_RUN_ID=$GHOSTTY_SITES_RUN_ID" /proc/[0-9]*/environ 2>/dev/null | tr '\0' '\n' || true)
}

collect_descendant_pids() {
  local roots
  roots=$(
    {
      printf '%s\n' ${child_pids[@]+"${child_pids[@]}"} ${tracked_pids[@]+"${tracked_pids[@]}"}
      find_tagged_pids
    } | sort -u | tr '\n' ' '
  )
  [[ -n "${roots// /}" ]] || return 0
  ps -eo pid=,ppid= | awk -v roots="$roots" -v self="$$" '
    BEGIN {
      n = split(roots, arr, " ")
      for (i = 1; i <= n; i++) if (arr[i] != "" && arr[i] != self) seen[arr[i]] = 1
    }
    { kids[$2] = kids[$2] " " $1 }
    END {
      changed = 1
      while (changed) {
        changed = 0
        for (p in seen) {
          m = split(kids[p], k, " ")
          for (i = 1; i <= m; i++) {
            if (k[i] != "" && k[i] != self && !(k[i] in seen)) {
              seen[k[i]] = 1
              changed = 1
            }
          }
        }
      }
      for (p in seen) print p
    }
  '
}

snapshot_live_pids() {
  local pid state
  declare -a next=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    if [[ -n "$state" && "${state:0:1}" != Z && "${state:0:1}" != X ]]; then
      next+=("$pid")
    fi
  done < <(collect_descendant_pids)
  tracked_pids=(${next[@]+"${next[@]}"})
}

escalate_remaining() {
  local pid _attempt
  for pid in ${child_pids[@]+"${child_pids[@]}"}; do
    signal_child "$pid" KILL
  done
  for pid in ${tracked_pids[@]+"${tracked_pids[@]}"}; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  for _attempt in $(seq 1 20); do
    snapshot_live_pids
    [[ "${#tracked_pids[@]}" == 0 ]] && break
    sleep 0.1
  done
  if [[ "${#tracked_pids[@]}" -gt 0 ]]; then
    echo "verify-sites.sh: descendants still alive after SIGKILL: ${tracked_pids[*]}" >&2
  fi
}

cleanup() {
  if [[ "$cleaned" == 1 ]]; then return; fi
  cleaned=1
  local pid _attempt
  # Snapshot full ppid tree before signalling parents so detached Playwright browsers stay tracked.
  snapshot_live_pids
  for pid in ${child_pids[@]+"${child_pids[@]}"}; do
    signal_child "$pid" TERM
  done
  for pid in ${tracked_pids[@]+"${tracked_pids[@]}"}; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for _attempt in $(seq 1 30); do
    snapshot_live_pids
    [[ "${#tracked_pids[@]}" == 0 ]] && break
    sleep 0.1
  done
  if [[ "${#tracked_pids[@]}" -gt 0 ]]; then
    escalate_remaining
  fi
  for pid in ${child_pids[@]+"${child_pids[@]}"}; do
    wait "$pid" 2>/dev/null || true
  done
  child_pids=()
  tracked_pids=()
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
