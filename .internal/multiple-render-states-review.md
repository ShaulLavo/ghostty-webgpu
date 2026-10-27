# Multiple render states review corrections

Status: Approved. PR #9 review at `b246eea939c6325b68efcd3fa1525af0d2762473`.

The review found two distinct consumption boundaries. `ZigFrameBuilder.ensureActive()`
called the subscriber's preparation callback on getters and glyph-cache operations. Those
operations only access already-built records, so they must not observe a newer native
snapshot. Preparation belongs in `build()`; lifetime validation stays on every operation.

WebGPU's coordinated path captured retained text inside deferred `commit()`. Another
subscriber could replace the shared native viewport after command encoding, so that capture
published newer text than the command's pixels. Retained text and an acknowledgement bound
to the consumed version must be staged during encoding and accepted or discarded at submission.
The acknowledgement also stays bound when another read of the same subscriber occurs before
commit. Named public methods and their signatures remain stable for the X7 dependent lane.

The review tests cover six cached-builder operations and two deferred-commit interleavings.
The browser cases compare the committed pixels to an independently submitted reference and
check the retained text, pending newer damage and subsequent catch-up frame.

Main is integrated with a merge commit, without rebase or force-push. PR #11's bridge-based
native clean replaces only shared native acknowledgement. B1's per-consumer version filtering,
damage distribution, preparation invalidation, scalar storage and iterator helpers remain.

Before setup, the original B1 worktree had already been removed. Existing wave worktrees,
services, caches, heavy jobs and review evidence under `rv9/` belong to their current owners.
This correction owns `/work/worktrees/ghostty-webgpu/b1-review`, its dependencies, dist,
Vitest screenshots and heavy-runner jobs. Vitest and the runner tear down their children on
exit. No dev server, deployment, upstream checkout or headed browser is created. The task
worktree and task scratch files are removed after pushing and posting the review reply.
Small logs and screenshots in `/work/reports/ghostty-webgpu-next-2026-10/b1-review/` remain
for coordinator review and can be removed after the corrected PR merges.
