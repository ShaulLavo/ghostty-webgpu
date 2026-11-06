# Record attribution protocol

Status: Approved bounded prerequisite, not a compact-layout candidate.

The runtime base is release `5dc81e804a7f728a27ba6d6a8fd8b30026cc9caf`. The research branch starts at analyzer checkpoint `c685fa13a2afe086d8580ad5178a99c45063acf0`. Fresh origin/main equals that release before execution. Production source, native core, record descriptors, strides, shaders, retention policy, worker transport and checked-in binaries stay unchanged.

## Hypothesis and method

The existing whole-builder boundary hides record construction and comparison inside traversal and glyph work. Generate an isolated research bridge from our bridge source, using the pinned official headers and the release's Zig 0.16.0 ReleaseSmall recipe. Do not rebuild or modify upstream Ghostty. The generator requires unique literal source anchors and writes only to the job's scratch directory.

The construction helper contains the original zeroing, selection/color/cursor/geometry work and cell writes. It returns color and geometry for the original glyph lookup. The glyph helper contains only the original glyph-record writes after lookup. Snapshot timing covers the original 64- and 96-byte prior-record loads. Comparison timing covers the existing record comparisons and dirty-range bounds. Glyph-index resolution is measured separately. Native cell decoding, raw-cell reuse decisions, row planning, traversal and other work remain outside the record regions. ReuseFrameRow's retained-row comparison path is not instrumented. No all-path or sparse/scroll attribution is claimed.

Clock probes use an imported bound browser performance.now function and native f64 accumulators. Each region also measures an empty two-clock interval immediately beforehand. Subtract the empty mean times that region's call count, preserving raw totals, counts and any negative residuals. The empty interval approximates crossing/clock overhead, not the effects of extraction, barriers, quantization, scheduling, cache changes or clock calls between regions. No corrected region is treated as a shipping speedup or a rigorous whole-browser CPU bound.

Each backend/workload runs two counterbalanced four-arm groups. Forward is released, extracted, timed, positive. Reverse reverses that order.

- Released uses the checked-in bridge.
- Extracted uses noinline helpers without native clock calls.
- Timed adds the clock probes and executes construction once.
- Positive uses the same timed bridge and executes the actual construction helpers 32 times at each original site. It does not repeat traversal, glyph lookup, input delivery, GPU submission or expanded-record comparison. The unchanged final write is still the original record. A construction timing increase with equal output and counters is the executable component-specific positive control. Its extra work is deliberate and never called an optimization.

The data shape separates region durations and invocation counts, buffer capacities and hashes, uploaded byte counts, parse bytes, native acknowledgements, submission counts, decoded screenshot pixels, callback time, renderer CPU and GPU-process CPU. No worker comparison runs. One main-realm runtime, builder, subscription and device execute each arm, with a no-op frame callback and needsFrameRows false, matching the retained 005 driver.

## Inputs and paint qualification

Use the original 64 NTCharts and plasma chunks and their original 100 by 30 grid, without combining or splitting chunks. Deliver Uint8Array chunks directly, once per update, through the current native benchmark driver. Verify each binary's recorded SHA-256. Also run 64 200 by 50 ASCII frames in which every nonblank character changes each step. This is a new full-changing control, not the earlier sequence-digit fixture. All arms use the same explicit JetBrains Mono file and DPR 2.

Before timing, independently require at least 99.9% of the actual full canvas backing to paint an explicit solid true-color clear. Then require application warmup to replace it. Recheck final geometry and require workload pixels to differ from the solid control. Compare exact final text, full cell/glyph-buffer SHA-256, decoded screenshot SHA-256, byte delivery, builds, row counts, uploads, acknowledgements and submissions across all arms. Hardware shader draw/readback controls for both backends must pass and reject software adapters. This verifies paint and completed draws, not per-update compositor presentation or physical scanout.

Four initial application chunks and eight warmup chunks precede 64 measured original chunks. Capture CPU independently through CDP process counters. Native region durations are wall-clock intervals on the actual bridge path, not CPU samples. Do not label them whole-terminal CPU or GPU execution time. Keep instrumentation overhead and resolution limits visible.

## Resources and stopping

Use the PC runner's quiet bench admission, a private headed Xvfb display and the existing hardware flags. Install shell traps before creating scratch or installing dependencies. Close page/browser/server in finally and stop owned process groups before removing scratch. Do not touch foreign services, caches or displays. Record pre-existing resources and verify actual-host cleanup afterward. No Mac acquisition, device session, reference checkout or product checkout is needed. Read existing upstream objects for exact pinned headers only.

Stop this method after a bounded corrected attempt if it cannot separate the target. No layout design follows without satisfying the original reopening condition. The eventual 20% dense CPU gate, no sparse/scroll regression, both backends, PC and Mac, both grids, counts and original workloads remain unchanged.

Throughput checkpoint: the bridge component instrument is the only implementation thread. Hardware acquisition waits on the self-service quiet runner. Analyzer and protocol work are independent. Parallel design and nested review are skipped under the binding no-subagent brief. The coordinator supplies independent review.

## Corrected CPU delivery boundary

The initial component cohort completed 48 arms. Its native intervals and equivalence controls remain useful, but its process counters include the controller's number-array serialization and page-side Uint8Array construction. Exclude that channel from terminal CPU interpretation.

The bounded corrected cohort prepares the complete original Uint8Array chunk list in the page before warmup and process sampling. Measured replay receives no chunk payload through CDP. It passes those same owned arrays, one at a time and without concatenating or rechunking, to the same native driver. This matches the original study's prepared-input boundary. CPU is read immediately after replay, before reading native probe counters.

The corrected cohort keeps two counterbalanced repetitions for each backend and all three workloads. Its three arms are released, timed and positive, reversed for the second group. The already-qualified extraction-only control is not rerun. There are 36 arms, not an acceptance matrix. A 540-second controller deadline sits inside the runner's unchanged 600-second execution bound. Every native clock/record region and the 32-repeat positive control is unchanged.

## Frozen launcher

Use `launch.sh`, which reads the complete run script into an immutable `bash -c` argument before execution. During the corrected acquisition, adding a post-build hash command to the active on-disk wrapper shifted Bash's read position after its wait command. The browser acquisition and analyzer had finished successfully, but Bash then reported an unexpected EOF and did not run the strict tool check. Teardown still ran. No measurement is invalidated by that post-acquisition parser failure. The separate check-only command supplies the missing static check. The frozen launcher prevents this source-edit/parser coupling in future runs.
