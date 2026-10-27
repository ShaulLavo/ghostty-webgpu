#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$HOME/.bun/bin:/opt/homebrew/bin:$PATH
host=$1
out=$2
before=$3
candidate=$4
workloads=$5
export BENCH_BASELINE_ROOT=$before F4_CANDIDATE_ROOT=$candidate BENCH_BACKENDS=webgl2,webgpu BENCH_DEFAULT_GPU=1 BENCH_DPR=2 BENCH_STEPS=30 BENCH_WARMUP_STEPS=5 BENCH_REPETITIONS=2 BENCH_SCREENSHOTS=1 BENCH_TRACE=1
mkdir -p "$out"
run() {
  local name=$1
  shift
  if test -f "$out/$host-$name.done"; then return; fi
  python3 ~/.agents/skills/machine-fleet/scripts/availability.py check --owner-only > "$out/$host-$name-availability.json"
  if test "$host" = pc; then
    nvidia-smi > "$out/$host-$name-gpu.txt"
    test "$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits)" -ge 2048 || return 75
  fi
  env "$@" BENCH_OUTPUT="$out/$host-$name.json" bun run bench:renderer > "$out/$host-$name.log" 2>&1
  touch "$out/$host-$name.done"
}
cd "$before"
for grid in 200x50 80x24; do
  export BENCH_COLUMNS=${grid%x*} BENCH_ROWS=${grid#*x}
  for count in 1 16; do
    export BENCH_COUNT=$count
    run "$grid-$count-standard" BENCH_SCENARIOS=burst-output,sustained-scroll,cursor-movement,sparse-edit,dense-redraw,glyph-churn,cold-cache
    for fixture in ascii ntcharts-heatmap opentui-plasma; do
      run "$grid-$count-$fixture" BENCH_SCENARIOS=external BENCH_WORKLOAD="$workloads/$fixture"
    done
  done
done
