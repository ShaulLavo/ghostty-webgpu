#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$HOME/.bun/bin:$PATH
host=$1
out=$2
workloads=$3
before=$4
mkdir -p "$out"
export BENCH_BACKENDS=webgpu,webgl2 BENCH_DEFAULT_GPU=1 BENCH_STEPS=120 BENCH_WARMUP_STEPS=10 BENCH_REPETITIONS=4 BENCH_TRACE=1 BENCH_REUSE_PAGE=1 BENCH_DPR=2 BENCH_BASELINE_ROOT="$before"
run() {
  local name=$1
  shift
  if test -f "$out/$host-$name.done"; then return; fi
  if test "$host" = pc; then
    nvidia-smi > "$out/$host-$name-gpu.txt"
    test "$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits)" -ge 2048 || return 75
  fi
  env "$@" BENCH_OUTPUT="$out/$host-$name.json" bun run bench:renderer > "$out/$host-$name.log" 2>&1
  touch "$out/$host-$name.done"
}
grids=${F2_GRID:-"80x24 200x50"}
counts=${F2_COUNT:-"1 16"}
if test "$host" = pc; then
  grids=${F2_GRID:-80x24}
  counts=${F2_COUNT:-1}
fi
run_configuration() {
  run "$grid-$count-ascii" BENCH_SCENARIOS=external BENCH_WORKLOAD="$workloads/ascii"
  run "$grid-$count-stages" BENCH_SCENARIOS=burst-output,sustained-scroll,cursor-movement,sparse-edit,dense-redraw,glyph-churn,cold-cache BENCH_SCREENSHOTS=0 BENCH_STEPS=60 BENCH_REPETITIONS=2
  for fixture in ntcharts-heatmap opentui-plasma; do
    run "$grid-$count-$fixture" BENCH_SCENARIOS=external BENCH_WORKLOAD="$workloads/$fixture" BENCH_SCREENSHOTS=0 BENCH_STEPS=60 BENCH_REPETITIONS=2
  done
}
if test "${F2_PHASE:-matrix}" != extras; then
  for grid in $grids; do
    export BENCH_COLUMNS=${grid%x*} BENCH_ROWS=${grid#*x}
    for count in $counts; do
      export BENCH_COUNT=$count
      run_configuration
    done
  done
fi
if test "$host" = pc && test "${F2_PHASE:-matrix}" != extras; then exit 0; fi
export BENCH_COLUMNS=80 BENCH_ROWS=24 BENCH_COUNT=1
run gpu-attribution BENCH_SCENARIOS=burst-output BENCH_GPU_TRACE=1 BENCH_REPETITIONS=2 BENCH_STEPS=120 BENCH_SCREENSHOTS=0
run ascii-attribution BENCH_SCENARIOS=external BENCH_WORKLOAD="$workloads/ascii" BENCH_GPU_TRACE=1 BENCH_REPETITIONS=2 BENCH_STEPS=120 BENCH_SCREENSHOTS=0
run unicode BENCH_SCENARIOS=warm-unicode BENCH_REPETITIONS=2 BENCH_STEPS=20
bun run build
if test "$host" = pc; then
  test "$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits)" -ge 2048 || exit 75
fi
GHOSTTY_BROWSER_HARDWARE=1 bun run test:browser src/render/tests/renderer.browser.test.ts src/render/tests/zig-unicode.browser.test.ts src/render/tests/held-output.browser.test.ts src/render/tests/synchronized-output.browser.test.ts src/dom/tests/displayed-frame-boundaries.browser.test.ts > "$out/$host-hardware-tests.log" 2>&1
