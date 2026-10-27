# Review probe results

These are bounded hardware diagnostics at 200×50 DPR 2. Both arms use the attached producer port, with the same message, bytes and acknowledgement path; only the transfer list changes. This isolates transport semantics without comparing different public API paths. Four warmup updates precede 24 measured updates per arm. Mode order is clone/transfer/transfer/clone. Timings are experimental and are not a throughput or presentation claim. Short postMessage samples can be zero at the browser timer resolution.

Clone buffers stay readable after sending; transferred buffers detach. The exporter checks 24 contiguous acknowledgements and parser calls per arm, plus equal text hashes and submission counts within every backend/size group. WebGPU submits 24 frames per arm; WebGL2 skips identical records in this fixture and submits zero. This does not compare renderer throughput.

| Host | Backend | Bytes/update | Mode/order   | postMessage p50 ms | Parse-ack p50/p95 ms | Submissions |
| ---- | ------- | -----------: | ------------ | -----------------: | -------------------: | ----------: |
| pc   | webgpu  |         4096 | clone / 0    |              0.000 |        0.300 / 0.500 |          24 |
| pc   | webgpu  |         4096 | transfer / 1 |              0.000 |        0.300 / 0.500 |          24 |
| pc   | webgpu  |         4096 | transfer / 2 |              0.000 |        0.400 / 0.600 |          24 |
| pc   | webgpu  |         4096 | clone / 3    |              0.000 |        0.300 / 0.700 |          24 |
| pc   | webgpu  |        65536 | clone / 0    |              0.000 |        0.600 / 1.000 |          24 |
| pc   | webgpu  |        65536 | transfer / 1 |              0.000 |        0.600 / 1.000 |          24 |
| pc   | webgpu  |        65536 | transfer / 2 |              0.000 |        0.600 / 0.800 |          24 |
| pc   | webgpu  |        65536 | clone / 3    |              0.100 |        0.600 / 0.900 |          24 |
| pc   | webgpu  |      1048576 | clone / 0    |              0.300 |        6.000 / 8.300 |          24 |
| pc   | webgpu  |      1048576 | transfer / 1 |              0.000 |        4.500 / 5.200 |          24 |
| pc   | webgpu  |      1048576 | transfer / 2 |              0.000 |        4.200 / 7.300 |          24 |
| pc   | webgpu  |      1048576 | clone / 3    |              0.400 |        4.800 / 5.100 |          24 |
| pc   | webgl2  |         4096 | clone / 0    |              0.000 |        0.300 / 0.400 |           0 |
| pc   | webgl2  |         4096 | transfer / 1 |              0.000 |        0.500 / 0.600 |           0 |
| pc   | webgl2  |         4096 | transfer / 2 |              0.000 |        0.400 / 0.600 |           0 |
| pc   | webgl2  |         4096 | clone / 3    |              0.000 |        0.400 / 0.600 |           0 |
| pc   | webgl2  |        65536 | clone / 0    |              0.100 |        0.700 / 1.200 |           0 |
| pc   | webgl2  |        65536 | transfer / 1 |              0.000 |        0.600 / 0.700 |           0 |
| pc   | webgl2  |        65536 | transfer / 2 |              0.000 |        0.600 / 0.700 |           0 |
| pc   | webgl2  |        65536 | clone / 3    |              0.000 |        0.600 / 1.000 |           0 |
| pc   | webgl2  |      1048576 | clone / 0    |              0.300 |        4.900 / 8.100 |           0 |
| pc   | webgl2  |      1048576 | transfer / 1 |              0.000 |        4.200 / 5.100 |           0 |
| pc   | webgl2  |      1048576 | transfer / 2 |              0.000 |        4.100 / 4.400 |           0 |
| pc   | webgl2  |      1048576 | clone / 3    |              0.300 |        4.800 / 6.600 |           0 |

## Recovery adapter observations

GPUDevice.adapterInfo is read from the current renderer device before and after recovery. Local device identity and the restore counter prove that the snapshots straddle a device rebuild. WebGL metadata is queried from the restored context. Empty WebGPU device/description strings are preserved, not filled from a stale initial adapter or from the browser-wide GPU label. Web APIs expose no physical GPU serial identity.

| Evidence                     | Entry/backend | Submission ms | Restores | Current adapter metadata after recovery                                                                           |
| ---------------------------- | ------------- | ------------: | -------: | ----------------------------------------------------------------------------------------------------------------- |
| `review-r1/pc-channels.json` | main/webgpu   |        81.300 |        1 | vendor=nvidia; architecture=ampere; device=''; description=''; fallback=False                                     |
| `review-r1/pc-channels.json` | worker/webgpu |        73.000 |        1 | vendor=nvidia; architecture=ampere; device=''; description=''; fallback=False                                     |
| `review-r1/pc-channels.json` | main/webgl2   |             - |        - | Error: evaluate: TypeError: Cannot read properties of null (reading 'UNMASKED_VENDOR_WEBGL')                      |
| `review-r1/pc-channels.json` | worker/webgl2 |       116.900 |        1 | Google Inc. (NVIDIA Corporation); ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Ti/PCIe/SSE2, OpenGL ES 3.2) |

WebGL restoration is explicitly requested after 100 ms, which is included in its submission latency. The first PC main WebGL attempt queried an extension while the context was lost and failed. Its record is retained; the diagnostic now returns lost-context state before querying extensions. The inventory identifies whether the guarded recovery-only rerun was acquired.

M7 and M8 remain partial. The Mac review cohort needs a released shared-host lock. Overload behavior, actual DPR rebuilds and interval peak-memory measurements are outside these new diagnostic results. See the per-channel inventory for each missing acquisition or observed failure.
