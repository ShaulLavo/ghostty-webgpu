#!/usr/bin/env bash
set -euo pipefail
repo=${1:?Supplied worktree}
report=${2:?Report evidence directory}
packet=''
cleanup() { if [[ -n "$packet" ]]; then rm -rf -- "$packet"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
packet=$(mktemp -d /work/tmp/g5boat.XXXXXX)
git -C /work/worktrees/ghostty/gh-cha archive 7b11f3dca034d8d24369ad3856afe57946d7902a include | tar -x -C "$packet"
boat limits --all >"$report/boat-limits.txt"
G5_BOAT_REPO="$repo" G5_BOAT_PACKET="$packet" bun -e '
const args = ["ghostty-webgpu", "c685fa13a2afe086d8580ad5178a99c45063acf0", "--worktree", process.env.G5_BOAT_REPO, "--input", "headers=" + process.env.G5_BOAT_PACKET + "/include", "--timeout", "240", "--artifact", "attribution-check", "--", "bash", ".internal/compact-record-attribution/remote-check.sh"];
await Bun.write(process.env.G5_BOAT_PACKET + "/matrix.json", JSON.stringify({jobs: [{name: "record-instrument-build", args}]}));'
bun "$HOME/.agents/skills/machine-fleet/scripts/boat-matrix.ts" "$packet/matrix.json" --parallel 1
