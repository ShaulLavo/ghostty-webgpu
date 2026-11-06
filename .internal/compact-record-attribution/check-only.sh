#!/usr/bin/env bash
set -euo pipefail
repo=${1:?Supplied worktree}
evidence=${2:?Report evidence directory}
[[ ! -e "$repo/node_modules" ]]
root=''
cleanup() {
  local status=$?
  trap - EXIT
  rm -f "$repo/node_modules"
  if [[ -n "$root" ]]; then du -sb "$root" >"$evidence/check-removed-size.txt"; rm -rf -- "$root"; fi
  printf 'exit=%s dependency_link_absent=%s scratch_absent=%s\n' "$status" "$([[ ! -e "$repo/node_modules" ]] && echo yes)" "$([[ ! -e "$root" ]] && echo yes)" >"$evidence/check-cleanup.txt"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
root=$(mktemp -d /work/tmp/g5check.XXXXXX)
printf 'scratch=%s\n' "$root" >"$evidence/check-resources.txt"
cp "$repo/package.json" "$repo/bun.lock" "$root/"
cp -r "$repo/patches" "$root/patches"
BUN_INSTALL_CACHE_DIR=/work/cache/bun/cache bun install --cwd "$root" --frozen-lockfile --ignore-scripts --backend=copyfile >"$evidence/check-install.log" 2>&1
ln -s "$root/node_modules" "$repo/node_modules"
export G5_REPO="$repo" G5_OUTPUT="$evidence" G5_SCRATCH="$root"
bun "$repo/.internal/compact-record-attribution/check.ts"
bun "$repo/.internal/compact-record-attribution/table.ts" "$evidence/acquisition.json" "$evidence/table.json" >"$evidence/table.md"
"$repo/node_modules/.bin/oxfmt" --check "$repo/.internal/compact-record-attribution" >"$evidence/format.log" 2>&1
