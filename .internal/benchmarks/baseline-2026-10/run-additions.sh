#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$HOME/.bun/bin:$PATH
host=$1
out=$2
workloads=$3
export BENCH_BACKENDS=webgpu BENCH_STEPS=60 BENCH_WARMUP_STEPS=10 BENCH_REPETITIONS=2 BENCH_SCREENSHOTS=0 BENCH_TRACE=1 BENCH_REUSE_PAGE=1 BENCH_DPR=2 BENCH_COLUMNS=200 BENCH_ROWS=50
run() {
 local name=$1
 shift
 if test "$host" = pc; then
   nvidia-smi > "$out/$host-$name-gpu.txt"
   test "$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits)" -ge 2048 || return 75
 fi
 env "$@" BENCH_OUTPUT="$out/$host-$name.json" bun run bench:renderer > "$out/$host-$name.log" 2>&1
}
run timestamps BENCH_TIMESTAMP=1 BENCH_COMPLETION=1 BENCH_SCENARIOS=burst-output,sustained-scroll,cursor-movement,sparse-edit,dense-redraw,glyph-churn,cold-cache
if test "$host" = mac; then
 for grid in 200x50 80x24; do
   export BENCH_COLUMNS=${grid%x*} BENCH_ROWS=${grid#*x}
   run "$grid-energy" BENCH_BACKENDS=webgpu,webgl2 BENCH_ENERGY=1 BENCH_DEFAULT_GPU=1 BENCH_SCENARIOS=burst-output,sustained-scroll,cursor-movement,sparse-edit,dense-redraw,glyph-churn,cold-cache
   for fixture in ascii ntcharts-heatmap opentui-plasma; do
     run "$grid-energy-$fixture" BENCH_BACKENDS=webgpu,webgl2 BENCH_ENERGY=1 BENCH_DEFAULT_GPU=1 BENCH_SCENARIOS=external BENCH_WORKLOAD="$workloads/$fixture"
   done
 done
fi
