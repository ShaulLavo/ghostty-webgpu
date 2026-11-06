#!/usr/bin/env bash
set -euo pipefail
repo=${1:?Pass supplied worktree}
tool=$(cd "$(dirname "$0")" && pwd)
evidence=${G5_OUTPUT:?Set report-owned output directory}
checker="$HOME/.agents/skills/machine-fleet/scripts/availability.py"
python3 "$checker" check
mountpoint -q /work
git -C "$repo" fetch origin main >"$evidence/fetch-main.log" 2>&1
git -C "$repo" diff --stat 5dc81e804a7f728a27ba6d6a8fd8b30026cc9caf..origin/main -- scripts/bridge.zig src/core/zig-frame.ts src/render bench/renderer-benchmark-entry.ts >"$evidence/pre-execution-drift.txt"
[[ ! -s "$evidence/pre-execution-drift.txt" ]]
[[ ! -e "$repo/node_modules" ]]
scratch=''
xpid=''
jobpid=''
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$jobpid" ]]; then kill -- "-$jobpid" 2>/dev/null || true; wait "$jobpid" 2>/dev/null || true; fi
  if [[ -n "$xpid" ]]; then kill -- "-$xpid" 2>/dev/null || true; wait "$xpid" 2>/dev/null || true; fi
  if [[ -n "$scratch" ]]; then bun "$tool/cleanup.ts" "$scratch" >"$evidence/owned-process-cleanup.json"; fi
  rm -f "$repo/node_modules"
  if [[ -n "$scratch" ]]; then du -sb "$scratch" >"$evidence/removed-size.txt"; rm -rf -- "$scratch"; fi
  printf 'exit=%s scratch_absent=%s worktree_dependency_link_absent=%s tool_dependency_link_absent=%s\n' "$code" "$([[ ! -e "$scratch" ]] && echo yes)" "$([[ ! -e "$repo/node_modules" ]] && echo yes)" "$([[ ! -e "$tool/node_modules" ]] && echo yes)" >"$evidence/teardown.txt"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
scratch=$(mktemp -d /work/tmp/g5.XXXXXX)
printf "scratch=%s\n" "$scratch" >"$evidence/setup-resource.txt"
export TMPDIR="$scratch" TMP="$scratch" TEMP="$scratch" G5_SCRATCH="$scratch" G5_REPO="$repo" G5_OUTPUT="$evidence"
export BUN_INSTALL_CACHE_DIR=/work/cache/bun/cache
export XDG_CACHE_HOME="$scratch/cache" XDG_CONFIG_HOME="$scratch/config"
cp "$repo/package.json" "$repo/bun.lock" "$scratch/"
cp -r "$repo/patches" "$scratch/patches"
bun install --cwd "$scratch" --frozen-lockfile --ignore-scripts --backend=copyfile >"$evidence/install.log" 2>&1
ln -s "$scratch/node_modules" "$repo/node_modules"

mkdir "$scratch/native"
cp "$repo"/scripts/*.zig "$scratch/native/"
git -C /work/worktrees/ghostty/gh-cha archive 7b11f3dca034d8d24369ad3856afe57946d7902a include | tar -x -C "$scratch/native"
sha256sum "$tool"/* >"$evidence/tool-source-hashes.txt"
bun "$tool/generate.ts" "$repo" "$scratch/native" >"$evidence/generate.log"
export ZIG_GLOBAL_CACHE_DIR=/work/cache/zig/global ZIG_LOCAL_CACHE_DIR="$scratch/zig-cache"
for variant in extracted timed; do
  /work/tools/zig/0.16.0/zig build-exe "$scratch/native/$variant.zig" -target wasm32-freestanding -fno-entry -rdynamic --import-memory --export=__stack_pointer --stack 65536 -I "$scratch/native/include" -O ReleaseSmall -femit-bin="$scratch/$variant.wasm" >"$evidence/build-$variant.log" 2>&1
done
sha256sum "$scratch"/{extracted,timed}.wasm "$scratch/native"/{extracted,timed}.zig "$repo"/{bridge,ghostty-vt}.wasm >"$evidence/native-hashes.txt"
url=$(pacman -Sp --print-format '%l' xorg-server-xvfb)
curl --fail --location --max-time 120 "$url" -o "$scratch/xvfb.pkg.tar.zst" >"$evidence/download.log" 2>&1
bsdtar -xf "$scratch/xvfb.pkg.tar.zst" -C "$scratch" usr/bin/Xvfb
unset WAYLAND_DISPLAY
setsid "$scratch/usr/bin/Xvfb" -displayfd 3 -screen 0 2000x1200x24 -nolisten tcp -ac 3>"$scratch/display" >"$evidence/xvfb.log" 2>&1 &
xpid=$!
for _ in $(seq 1 50); do
  [[ -s "$scratch/display" ]] && break
  kill -0 "$xpid"
  sleep 0.1
done
[[ -s "$scratch/display" ]]
export DISPLAY=":$(cat "$scratch/display")"
python3 "$checker" check
printf 'scratch=%s display=%s xvfb=%s\n' "$scratch" "$DISPLAY" "$xpid" >"$evidence/resources.txt"
setsid timeout --signal=TERM --kill-after=8 540s bun "$tool/probe.ts" >"$evidence/probe.log" 2>&1 &
jobpid=$!
printf 'job=%s\n' "$jobpid" >>"$evidence/resources.txt"
wait "$jobpid"
bun "$tool/analyze.ts" "$evidence/acquisition.json" "$evidence/summary.json" >"$evidence/analyzer.log" 2>&1
bun "$tool/check.ts" >"$evidence/check.log" 2>&1
