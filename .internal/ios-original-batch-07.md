# Complete original stamp cache preparation

Status is Approved preparation, not native qualification.

Batch 07 selects only `src/render/pixels/stamp-cache.browser.test.ts`, all six
ordinary cases under `Canvas resident stamp cache`, through `stamp-cache`.
The original and its reference cache, storage fixture, imports, assertions,
loops, mocks, memory operations and clocks remain unchanged.

The full static graph has nine modules and twelve edges. The runtime graph uses
the original, reference cache, storage fixture, error module and ABI enums.
The production cache is only a type import from the storage fixture. Canvas 2D,
getImageData, ImageData, ordinary WebAssembly.Memory and Vitest mocks require
no new provider command. The published Waffle 0.0.111 pin stays unchanged.

Independent review, required CI, merge, main CI and a fresh parent-owned native
handoff remain gates. No Safari run, native ID or root-suite completion is claimed.

There are 28 source assertion sites and 30 passing-path assertions after expanding
the three-row raster loop. No platform-dependent raster branch count is invented.
All 25 original function and arrow callback bodies remain byte-identical.
Fixed exclusions remain 35 touch and 16 N/A. Eleven completed originals stay frozen.
Batches 05 and 06 stay prepared pending native execution and are not selected again.
The exact packet is retained at
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch07/packet/`.
