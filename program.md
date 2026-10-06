# Ghostty performance autoresearch

Start with one instruction:

> Run ghostty-webgpu/program.md autonomously. Resume the current autoresearch checkpoint using the host's research binding. Research for at most four experiments or 60 elapsed minutes. Continue after each KEEP or REJECT without asking me to choose the next experiment.

The agent performs the loop. The checkpoint helper saves continuation state. It does not launch agents, schedule hardware, benchmark, or decide acceptance.

If the current checkpoint is a stopped setup dry run, read it as prior evidence. Start the requested research budget in a fresh research checkpoint and point the run-owned host binding there. Preserve the dry-run checkpoint and completed decisions.

## Load the current research

1. Read root `AGENTS.md`, `ghostty-webgpu/AGENTS.md`, and applicable skills. On the owner's host, load `fregat-local` and the current research standing orders. Use the existing coordinator and hardware executor when that programme owns resources. Autoresearch grants no new permissions.
2. Read the host's research binding and this run's checkpoint. Resolve the latest authoritative research checkpoint, results, renderer/realm status matrix, counterpart policy, decision log, and experiment closures. Inspect their contents and update times. An experiment's later final report can supersede a stale summary's "not yet measured" status. Preserve both records.
3. Read recent Fregat commits, open PRs/issues and their comments, and relevant experiment worktrees. Development belongs in this monorepo. Its current source is authoritative. The standalone mirror supplies no development baseline.
4. Resolve the current source commit, runtime inputs, benchmark driver, dependencies, WASM and font assets. Check source applicability against each acquisition pin. Record applicability separately. Never relabel an older acquired source with today's commit.
5. Recover unfinished work before creating an experiment. Inspect the exact worktree, diff, owned processes, hardware admission, original output directory, and recorded window identity. A live owned job is observed, not relaunched. A completed window is analyzed, not measured again.

If the host has no binding, discover existing research from the local instructions and evidence. Create a binding in the existing research evidence directory with paths to those authorities. If no qualified current baseline exists, the first task is a bounded baseline or missing required direct comparison using the existing procedure. Historical losses and missing qualification are different facts.

## Select one justified objective

Choose a demonstrated current loss or an explicitly open optimization target. Record renderer, execution realm, workload, count, counterpart, measured channel, baseline source, and evidence. Reconcile merged fixes and final negative results first. A closed rolling CPU gap cannot justify another rolling CPU optimization.

The latest local Canvas continuation, for example, already screened cached row-sized ImageData and opaque row clearing. Read its final closure before using either idea. The row-view candidate needs lifetime review and direct qualification. The opaque-clear result stays rejected. This example is a discovery hint, not a permanent priority list.

Write one falsifiable hypothesis. Name the measured bottleneck, the proposed mechanism, the source files allowed to change, the expected observable change, and the smallest experiment that could refute it. API counts or upload bytes alone do not establish a CPU bottleneck. If attribution is missing, make that the experiment.

Prefer material improvements with little additional state or complexity. Keep a rejection's mechanism and failure conditions searchable in the existing decision log. Retry a rejected idea only when new evidence changes the premise. Record the difference before any new acquisition.

## Register, isolate, and measure

1. Create a unique experiment ID and evidence directory under the existing research root. Record the hypothesis in the existing decision log. Save the `implement` checkpoint before changing source.
2. Use an owned Fregat worktree under the host's approved worktree root. Record branch and full base SHA. Keep peer worktrees and the shared checkout untouched. Claim an open issue before working on it. A retained candidate can be recovered from its recorded patch and source overlay, after applicability checks.
3. Freeze the protocol before launching a window. Reuse its existing registration, runner, comparison, analyzer, qualification, and evidence machinery. Record exact commands, source/bundle/driver pins, assets, workload, arms, order, thresholds, host/backend/realm, CPU accounting, endpoint, replacement policy, and output identities. Preserve the original protocol file and digest.
4. Change only the runtime files required by the hypothesis. Commit the isolated candidate by path so its source can be recovered. Existing benchmark files, workload bodies, counterpart implementations, acceptance thresholds, scoring, and acquisition guards are outside experiment edit scope. A benchmark defect requires separate work and a new prospective protocol. Its fix cannot rescue old results.
5. Run the narrowest existing correctness or benchmark check first. Use a small schema/mechanics screen when the existing procedure calls for one. Record `screen`, the command, owned job/process IDs, output path, and window ID before launch. Preserve stdout, stderr, exit code, partial output, and cleanup evidence, including failed admission.
6. Evaluate with the existing analyzer. A promising own-control screen advances to `qualify` and the existing required direct comparisons and broader correctness/workload checks. It is not a shipping win. Do not repeat a completed valid screen to seek a better ratio.

Use `scripts/build-comparison.ts --runtime-ref` for baseline runtime selection where the existing comparison procedure applies. Build both arms with the same pinned benchmark driver. Reuse sealed local capsules for specialized Canvas, ownership, or presentation studies. The generic runner's defaults cannot replace a newer authoritative counterpart policy or a specialized endpoint.

Headed hardware, quiet admission, AC/load/backend guards, native process accounting, balanced same-session pairs, cleanup, and immutable failed windows retain their existing meaning. Linux headless or software rendering qualifies only the scopes explicitly allowed by the current procedure. CPU or latency work on another host uses that host's resource owner. Never weaken guards to fit a research budget.

## Evaluate separate facts

Report these channels separately whenever measured:

- Renderer CPU.
- GPU-process CPU, which is host CPU spent in Chrome's GPU process.
- Renderer plus GPU-process CPU.
- All-Chrome CPU, including other Chrome processes.
- Latency and presentation at the registered endpoint.
- Memory buckets, including JS, WASM, native or process RSS where available.
- Correctness and actual work equivalence.

There is no universal score. A total-CPU win can coexist with a GPU-process loss. Name each regression and apply the registered acceptance rule for that channel. Do not multiply percentage gains across sessions or PRs. An exploratory result cannot prove significance or whole-program parity.

Correctness and equivalent work are hard gates. Check actual bytes, writes, frames, acknowledgements, publications, retained history, content, geometry, font/DPR, and original screenshots as required by the procedure. Reduced work must follow from the intended optimization, with equivalent output and public behavior. Skipped rendering, missing callbacks, missing history, or changed workloads reject the candidate.

JS write or callback timing cannot establish GPU completion, presentation, or physical-display improvement. GPU commands need the recorded completion endpoint when required. Presentation needs the current identity/clock/frame qualification. Physical scanout remains unmeasured unless the procedure measures it.

Use the original noise and resolution rules. The comparison reporter leaves CPU unresolved below the configured tick minimum or within one tick. The current local native CPU procedures use their original 100-tick guards and prospectively registered exploratory screens. Apply each procedure's actual rules, including strict latency failures. Do not introduce a permissive tolerance, confidence test, or reduced repetition count.

## Decide and continue

**REJECT** a regression, correctness/work failure, resolution-level or statistically inconclusive result, or tiny complexity-increasing benefit under the existing rules. Preserve the candidate commit or patch, raw windows, original analyzer output, failed guards, all metrics, reason, and the next hypothesis. Discarding means exclusion from the accepted baseline. It never means deleting losing evidence or resetting a shared checkout.

A rejected acquisition remains a rejection. Only the existing prospectively registered invalid-window replacement policy permits a replacement, under a new identity with the original failure linked. Never waive, reinterpret, rescore, stitch, improperly repeat, or silently drop a failed result. A crash fix changes source and experiment identity. It does not overwrite the original failure.

**KEEP** requires the existing qualification and correctness gates, a material supported improvement, and acceptable regressions under the original policy. Record the exact scope that won. Retain a qualified commit on its owned branch or integrate it through Fregat's existing patch-changeset, independent review, CI, merge, and deployment procedure. Respect existing owner/coordinator boundaries. No speculative merge demonstrates this loop.

An exploratory win remains a candidate in `qualify`. It cannot be promoted by wording its limitations away. If a qualified candidate stays on a research branch, call it retained and unmerged. Record that exact branch as the accepted research source.

After KEEP, enter `baseline`. Establish the new accepted baseline using the existing procedure, with source/workload applicability and actual acquisition identities recorded separately. A merge conflict or material source drift invalidates candidate applicability until checked. Do not build the next experiment on an unqualified combination of gains.

After REJECT, select the next justified hypothesis immediately. After KEEP and baseline establishment, do the same. Read the latest checkpoint and closures again before selection. Save the next action before ending any iteration. Do not ask the owner what to try when the evidence supplies a reasonable step.

Stop for a genuine blocker, a current authorization/safety boundary, exhaustion of justified hypotheses after source/evidence review, or the predefined budget. Record the reason, unfinished phase, owned resources, and precise resume action. A hardware queue gets bounded readiness checks under the existing procedure. Budget expiry does not change an acceptance threshold or justify rerunning a failed admission. Finish owned cleanup and save partial evidence.

## Save a resumable checkpoint

Keep continuation state in `autoresearch-checkpoint.json` inside the existing research evidence directory, owned by this run. Keep measurement records in their existing experiment packets, and decisions in the existing decision log. The root research matrix and coordinator state remain with their established writer. This file points to those authorities and carries the agent's next action.

Use the helper from the Fregat root:

```sh
node ghostty-webgpu/scripts/autoresearch-checkpoint.mjs read "$checkpoint"
node ghostty-webgpu/scripts/autoresearch-checkpoint.mjs write "$checkpoint" new "$input"
# Subsequent writes use the sha256 returned by read, in place of new.
```

Write the next checkpoint to a separate input file. The helper checks the expected current digest, preserves content-addressed history, and atomically replaces the checkpoint under an exclusive lock. It snapshots the proposed state after promotion, so an unpromoted temporary file cannot freeze a decision. It never evaluates a benchmark or edits research results. Re-read on a digest conflict. A crash can leave a lock and temporary file. Inspect the recorded PID and owned jobs before removing that stale run-owned lock. A checkpoint records agent intent and observed evidence. Verify actual benchmark completion from its original outputs.

Carry this structure, with actual paths and identities:

```json
{
  "mode": "research",
  "phase": "select",
  "nextAction": "Read the latest experiment closures and select a current objective",
  "references": [
    "path to host research binding",
    "path to current research state",
    "path to decision log"
  ],
  "budget": {
    "startedAt": "2026-10-06T00:00:00Z",
    "maxExperiments": 4,
    "completedExperiments": 0,
    "maxMinutes": 60
  },
  "baseline": { "commit": "full SHA", "qualification": "existing evidence path" },
  "experiment": null
}
```

For an active experiment, include ID, objective, hypothesis, allowed source paths, worktree/branch/base/candidate SHA, protocol and source pins, command/job/window/output identities, completed phases, metric/evaluation pointers, KEEP/REJECT reason, baseline establishment, and next hypothesis. Before measuring, save enough launch identity to distinguish an unstarted window from an interrupted or completed one.

Update before each irreversible external step and immediately after each measured result and decision. Keep budget start and totals across resumes. Count completed experiments across the run, including rejection and crash. The helper freezes the run mode and budget, prevents decreasing totals, and prevents changing or restarting a completed experiment identity. After a decision, carry the next experiment under a new ID, or set `experiment` to null in `select`. Establish a KEEP's baseline in the top-level `baseline` field while its decision record stays frozen.

A new instruction can explicitly start a fresh budget in a new checkpoint file. Preserve the old checkpoint and history, and update the run-owned host binding to the new file. Never convert `dry-run` evidence into research evidence.

On resume, recover the current experiment first. Verify outputs and process state directly. If a stopped measurement's completion is uncertain, retain it as interrupted/unqualified under its original identity and follow the existing replacement rule. Never guess that nothing was acquired and launch it again.

## Methodology source and setup proof

This loop adapts [Karpathy's program.md at 228791f](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md), read on 2026-10-06. It retains an agent-facing programme, bounded isolated experiments, fixed evaluation, baseline advancement, negative-result records, and autonomous continuation. Fregat's metrics, resource rules, qualification, stop conditions, and worktree discipline govern execution.

The [setup proof](docs/autoresearch-setup.md) records the bounded dry run. Run the checkpoint regression check with:

```sh
node --test ghostty-webgpu/scripts/autoresearch-checkpoint.test.mjs
```
