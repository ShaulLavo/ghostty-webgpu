#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$HOME/.bun/bin:$PATH
cd "$HOME/tmp/ghw-p0a"
checker=$HOME/.agents/skills/machine-fleet/scripts/availability.py
python3 "$checker" check > results/mac-final-before.json
mkdir "$HOME/tmp/.agent-mac-lock"
trap 'rm -f "$HOME/tmp/.agent-mac-lock/owner"; rmdir "$HOME/tmp/.agent-mac-lock"' EXIT
trap 'exit 143' TERM HUP
printf 'pid=%s task=p0a-final-endpoints\n' "$$" > "$HOME/tmp/.agent-mac-lock/owner"
python3 "$checker" check --owner-only
bun checks.mjs > results/mac-checks-attempt2.log 2>&1
BENCH_BACKENDS=webgpu BENCH_DEFAULT_GPU=1 BENCH_HOSTED=1 BENCH_WORKER=1 BENCH_TRACE=1 BENCH_STEPS=24 BENCH_WARMUP_STEPS=4 BENCH_REPETITIONS=1 BENCH_REUSE_PAGE=1 BENCH_SCENARIOS=burst-output,dense-redraw,glyph-churn BENCH_SCREENSHOTS=0 BENCH_OUTPUT="$PWD/results/mac-worker-heap.json" bun run bench:renderer > results/mac-worker-heap.log 2>&1
cp results/mac-m5.json results/mac-m5-attempt1.json
bun m5.mjs > results/mac-m5-attempt2.log 2>&1
