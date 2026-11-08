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
