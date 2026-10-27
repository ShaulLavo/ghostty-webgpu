# F2. Keep identical WebGPU output on screen

Status: Approved. Implementation and measurements are complete. Coordinator review, F10 integration and merge remain pending.

## Contract and implementation

The frame builder owns persistent records. Damage can rebuild those records without changing any bytes. WebGPU currently acquires and submits a new texture anyway. WebGL2 already accepts and publishes the update without submitting when uploads are empty.

Keep frame acceptance, retained displayed text, output acknowledgements and observer callbacks unchanged. Submitted-frame and draw counters count actual GPU work. An identical-output acceptance therefore remains observable without inventing a new GPU submission.

The skip decision must include full rebuilds, overlay rows, atlas uploads, instance operations and row-map bytes. Row-map uploads are excluded from the existing instance-operation return value. Cursor changes and blink phases enqueue overlay rows. Geometry, reconfiguration and recovery request full rebuilds. Selection invalidates the complete frame.

Accept unchanged state before flushing queued peer notifications, then notify its observers after peer submissions have settled. This prevents a frame callback from mutating a peer's source before that peer commits its encoded frame.

## Throughput checkpoint

The blocking steps are the failing browser reproduction and a hardware window on each host. The PC uses the shared runner; the Mac uses its atomic agent lock. Both are occupied at the start of the lane. The current code investigation and benchmark preparation proceed while those resources are busy.

One worker owns source, tests and measurements. The binding brief forbids delegation. The existing renderer runner and the P0a diagnostic patch provide the before/after comparison. No new renderer architecture is needed.

The rerunnable measurement controller and raw evidence live under `/work/reports/ghostty-webgpu-next-2026-10/f2/`. The comparison holds the source, wasm, browser and per-case parameters fixed. It counterbalances before/after and backend order in each browser session. Repeated output uses four repetitions; the wider workload matrix uses two and remains experimental. Each browser closes between cohorts. A separate traced rolling-log cohort provides GPU-process attribution without contaminating the primary CPU pair.

## Verification

The eight primary host/grid/count cells exceed the 30% observed CPU target. All 104 before/after screenshot pairs are identical within their backend. Parsed calls, input bytes, acknowledgements and text hashes match. Cursor blink and all 52 renderer tests pass on both hardware adapters. All 58 Unicode tests pass on the Mac after aligning the test fixture.

## Review decisions

Fix Root Causes changed the implementation boundary. The skip test failed on a real canvas acquisition before the fix. The full renderer suite then exposed that `capturePixels()` acquires a new, empty presentation texture after a skipped update. Explicit readback now renders the retained records into a disposable private texture. It leaves the visible canvas alone and destroys the readback texture and buffer in `finally`.

Laziness Protocol kept the submission path unchanged. A local guard exits before acquisition; a small acceptance helper preserves the existing observer transaction. There is no new renderer mode, scheduler, cache or cross-version handling.

Model the Domain and Type System Discipline kept the native upload plan as the source of truth. The guard checks byte traffic as well as operation counts. The frame-capture boundary now accepts a readonly list instead of copying it.

Build the Lever and Prove It Works produced `run-pairs.sh` and `summarize.py`. The summary checks paired text hashes, input sizes, parsed-call counts and pending-frame counts, then compares all screenshot pixels. It reports actual submitted counts separately from unmeasured presentation counts.

The binding brief overrides the playbook delegation and independent comment-review steps. The implementation worker starts no child agents; the coordinator owns independent review and merge.

Mac handoff, 2026-10-27 12:07 UTC. The initial F2 matrix finished and released its lock. Per coordinator instruction, F2 leaves the next opportunity to P0b for its forced-completion cohort and retakes only after P0b releases. Details are in the raw report mac-handoff.txt.

Coordinator correction at 12:15 UTC. P0b first slot ended before running its cohort. The current F2 final run completes and releases normally; F2 leaves the next slot to P0b and queues no further Mac runs.

## Mac fixture correction

The headed Unicode suite initially failed all 58 cases in both GPU backends. Its 72-pixel canvas started at CSS y=50.5 because the label used a platform-dependent normal line height. The browser cropped a 73-pixel image. A bounds probe reproduced the mismatch in both ASCII controls. Setting the fixture label line height to 20 pixels aligned the crop; all 58 Unicode cases then passed on the M1 hardware adapter. This changes only test layout. The before/after performance workloads and their captured images are unchanged.

## Reference-control finding

The existing xterm hold fixture returned `[0, 0, 0, 255]` instead of `[41, 91, 151, 255]` before entering a hold on headed M1 Chromium. It reproduced in the broad hardware run and in an isolated second attempt. The Ghostty renderer suite, main/prototype held-output cases, synchronized-output cases and displayed-frame boundaries passed in that hardware run. The same xterm fixture passed in the Linux software browser gate.

A fresh investigation can run `GHOSTTY_BROWSER_HARDWARE=1 bun run test:browser src/render/tests/held-output.browser.test.ts -t "holds and releases actual xterm"` on the M1 under the fleet lock. Inspect `xtermActor.read` in `src/render/tests/held-output.browser.test.ts` around line 250, its chosen canvas and sample coordinates. This branch uses xterm and its WebGL addon, so the F2 WebGPU submission guard does not execute. The cause is not established. Raw evidence is `mac-hardware-tests-first.log` and `xterm-reference-repeat.log` in the F2 report directory. No issue was opened.

## F10 integration requirement

Text blink is not present at the F2 base. The current `feat/text-blink` branch adds a uniform-only phase update in `drawZigFrame`. Its `setTextVisible` writes four bytes without updating the existing upload-byte counter. A naive merge could put the F2 guard before that call and suppress blink frames.

When combining F2 and F10, call `setTextVisible` before the skip guard and use its returned boolean as another draw reason, or explicitly exclude F10 `phaseChanged` frames. Run F10 text-blink tests after combining the branches, including a phase transition that coincides with identical damage-bearing output. The F2 base verifies cursor blink, identical overlay redraws and full invalidations. It cannot claim combined F10 coverage before that merge.

## Measurements

All-Chrome CPU reductions on repeated output are 64.18–72.82% on the PC and 48.90–65.07% on the M1. These are experimental observations from four balanced repetitions per cell. Both hosts cover 80×24 and 200×50, one and sixteen terminals, at DPR 2. Each terminal parses 120 writes in each repetition; its WebGPU submissions fall from 120 to zero. See `repeated-output.csv` and `all-workloads.csv`.

The PC is the i7-14700K with RTX 3060 Ti; the Mac is the M1 MacBook Air on AC power. Both use headed Chromium 153.0.8010.12 on hardware adapters. The control is `5aa4f4326`, whose runtime and wasm match P0a `d2ed8989a`. The measured implementation is `ec2c3c8d594928cda01adc32281c15bcbbc0b2df`; the final Mac source manifest checked all 301 files. A current-main check after native damage cleaning still reports partial damage on each identical overwrite, confirming that the optimization remains applicable.

## Remaining rolling-log cost

At 80×24 with one terminal, the untraced PC rolling-log case uses 17.61% all-Chrome CPU on WebGPU and 10.57% on WebGL2, a 66.7% excess. GPU-process CPU accounts for about 6.16 of the 7.05 percentage-point gap, while renderer CPU is 6.66% versus 6.24%. The corresponding Mac observation is 26.57% versus 22.01%, a 20.7% excess, split between renderer and GPU-process CPU.

The separate PC GPU trace records 247 command-buffer flushes for WebGPU versus 164 for WebGL2 over 120 rolling updates. WebGPU `CommandBuffer::Flush` takes 42.7–48.7 ms of inclusive thread CPU; WebGL2 takes 12.9–15.9 ms. Skia canvas swaps take 26.7–29.4 ms versus 5.65–6.09 ms, with 120 swaps in both backends. The remaining PC cost is predominantly Chrome GPU-process work in the WebGPU/Dawn command path and canvas delivery, rather than extra parser work. These nested scope timings are diagnostic and are not added together.

On the Mac, both backends present 120 times. CoreAnimation presentation scopes are similar, around 23–25 ms of inclusive thread CPU. WebGPU records 245–246 command scopes and 247–248 flushes, plus about 0.9 ms of Dawn IOSurface scheduling CPU. The traced overall gap shrinks to 4.1%, so that window does not reproduce the full untraced gap. The trace does not support blaming Mac presentation alone.

The PC repeated-output trace confirms the removed work. Before the change it records 120 swaps and 247 flushes; after it records zero swaps and two flushes. The unchanged image remains visible in the paired screenshots. Primary per-update presentation and physical scanout remain unmeasured.
