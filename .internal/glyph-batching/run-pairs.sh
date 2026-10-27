#!/usr/bin/env bash
export PATH=$HOME/.local/share/mise/shims:$HOME/.bun/bin:/opt/homebrew/bin:$PATH
set -euo pipefail
candidate=$1
baseline=$2
output=$3
mkdir -p "$output"
cd "$candidate"
for dpr in 1 2; do
  if [ "$(uname)" = Linux ]; then
    nvidia-smi --query-gpu=memory.free,memory.used,utilization.gpu --format=csv > "$output/gpu-dpr$dpr.txt"
    test "$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits)" -ge 2048
  fi
  BENCH_BASELINE_ROOT="$baseline" BENCH_DPR="$dpr" BENCH_BACKENDS=webgpu,webgl2 BENCH_SCENARIOS=glyph-churn,cold-cache BENCH_STEPS=64 BENCH_REPETITIONS=3 BENCH_WARMUP_STEPS=8 BENCH_OUTPUT="$output/dpr$dpr.json" bun run bench:renderer > "$output/dpr$dpr.log" 2>&1
done
if [ "$(uname)" = Linux ] && [[ "$output" = */pc ]]; then
  BENCH_ASCII_WARMUP=1 bash "$0" "$candidate" "$baseline" "${output}-warm"
fi
