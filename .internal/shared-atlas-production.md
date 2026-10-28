# Shared glyph atlases in production

Status: Approved. Implementation starts at `31ec756bb`; the warm-frame and failed-font-acquisition correction is `4a677e8c4`. This extracts C02 from `research/shared-resources-step2`. Pipelines and command encoders remain private to each terminal.

## Ownership

- A22's descriptor-complete resource identity scopes sharing to a `FontFaceSet`, its current resource generation, and a canonical fitted font. It includes DPR, geometry, baseline, family stack, weights, spacing, and all FontFace descriptors. Loading events and preloaded membership or descriptor changes retire acquisitions. The final owner removes the listeners.
- Each font entry owns its CPU atlas and rasterizer. Each GPU device has its own reference-counted texture set and texture version. Replacement devices upload the retained CPU pages.
- Each terminal keeps visible glyph pins and its own eviction queue. Warm builds refresh their pins without gathering peer pins. Allocation gathers every peer's pins, refuses peer compaction, and invalidates native registrations through each owner's queue.
- A grown or invalidated texture stays alive while any encoded frame can bind its version. The coordinator's commit or failure callback releases that frame's reference after the actual submit attempt. There is no retirement timer and no upload-time peer flush.
- Cache hits, misses, evictions, pages, and uploads are attributed to individual terminals. Cumulative counters survive font changes. Failing to acquire a new font leaves the prior font installed and releases the new registration.
- The page cap grows by 16 layers per attached owner, up to WebGPU's guaranteed 256 layers per kind. Allocation stays demand-sized. The cap does not shrink while an entry remains live. At the cap, pinned pages defer further glyphs rather than recycling a peer's visible glyphs.
- WebGL2 keeps private CPU/GPU atlases. Its contexts cannot share GPU textures.

## Hardware receipts

Both final runs use main `12d910c03` against candidate `4a677e8c4`, Chromium `153.0.8010.12`, WebGPU, DPR 2, 80×24, 300 rolling-output updates after 30 warmups. Four pairs alternate before/after order. These are experimental preservation checks, not speedup claims.

| Host            | Terminals | All-Chrome CPU, percent of one core | Atlas texels, MiB | Callback p95, ms |
| --------------- | --------: | ----------------------------------: | ----------------: | ---------------: |
| M1 Mac, Metal   |         1 |                       31.09 → 31.05 |       1.25 → 1.25 |    0.875 → 1.125 |
| M1 Mac, Metal   |        16 |                       45.45 → 45.52 |         20 → 1.25 |    1.875 → 2.350 |
| PC, RTX 3060 Ti |         1 |                       18.25 → 19.10 |       1.25 → 1.25 |    0.500 → 1.275 |
| PC, RTX 3060 Ti |        16 |                       63.70 → 75.46 |         20 → 1.25 |    4.750 → 5.775 |

The Mac is the timing gate, under its agent lock and on AC. The PC runs non-quiet under the coordinator's updated rule. `jobsDuringRun-*.jsonl` records concurrent jobs, including the full browser suite; PC timings do not establish a regression or speedup. The initial Mac extraction was 31.05 → 31.00 at one and 44.70 → 46.06 at sixteen; the final correction removes unnecessary peer-pin collection from warm frames.

Atlas storage is logical live texel bytes, deduplicated by GPUTexture identity. The 16-terminal saving is 93.75% on both hosts. This is not a process-RSS or driver-allocation claim. Callback p95 rises on the Mac by 0.25 ms at one and 0.475 ms at sixteen despite flat total CPU.

Every pair matches delivered bytes, native text, every terminal's GPU pixel hash, the visible canvas PNG hash, native frames, rebuilt rows, and submitted frames. Each measured window submits 300 or 4,800 frames for 240,000 or 3,840,000 parsed bytes. The diagnostic adds one pixel-readback submission per terminal after CPU sampling. Chrome presentation-event counts and physical scanout remain unmeasured.

Raw records, frozen bundles, PNGs, concurrent-job observations, commands, source archive hashes, the correction patch, and the rerunnable `analyze.py` are retained at `/work/reports/ghostty-webgpu-next-2026-10/x1-atlas-production/`. The cancelled PC quiet acquisition is retained separately and excluded. The Mac lock-label incident launched no C3 workload and did not change X1's processes.

## Verification

Focused browser controls cover equal shared output, font changes and rejoining, clearing a peer's atlas, DPR separation, disposing one or the final sharer, synthetic replacement and actual shared-device loss, failed font acquisition, and growth/invalidation while an old texture is pending in the coordinator. A22's real font-resource and descriptor controls are retained. Unit controls cover cross-owner compaction refusal, per-owner metrics, eviction queues, and a union larger than the original per-terminal cap without repeated misses or eviction.

The full gate sequence runs `build`, `typecheck`, `lint`, `format:check`, `test:unit`, `verify:extensions`, and then the complete `test:browser` suite. The first full run exposed the old DOM test's direct private-atlas injection. Its fixture now installs its tiny atlas through shared ownership and still exercises real eviction recovery.

Final results: 72 browser files pass, with 1,195 tests passed and five skipped. The unit Vitest project passes 1,217 tests with one skipped; its additional comparison, checkpoint, and worker-codec checks pass. Build, typecheck, lint, formatting, extension verification, and site documentation checks pass.

## Review follow-up: retirement without a later paint

The independent review reproduced a retained texture set after one sharer cleared the atlas, disposed before repaint, and left its peer idle. Retirement had been queued regardless of encoded references; only a later frame callback or final device release collected it. An idle second GPU device had the same problem after growth or invalidation.

Retirement now releases versions immediately when no encoded frame references them. Referenced versions remain queued until submission, failure, or owner detachment removes the final reference. Device-lease release follows that same rule, including its last lease. The reviewed peer-pin and encoded-frame searches also use flat control flow.

The failing-first ownership probe reports `owners=1, pendingFrames=0, retiredTextureSets=1, destroyed=0` before the fix and `owners=1, pendingFrames=0, retiredTextureSets=0, destroyed=1` after it. The frozen browser regression commit is `a1c1df9c7`. Browser controls cover clear/dispose with an idle peer, idle-device growth and invalidation alongside an active encoded frame, and final device-lease release followed by submission, failure, or detachment. Existing coordinator-submit readbacks remain the pending-texture safety control. This follow-up uses only PC SwiftShader; the reserved Mac is untouched. Logs are under the existing evidence root's `retirement-fix/` directory.
