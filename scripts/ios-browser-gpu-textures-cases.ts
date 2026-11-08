import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const gpuTexturesFile = fileURLToPath(
  new URL('../src/render/webgpu/gpu-textures.browser.test.ts', import.meta.url),
)

export const gpuTexturesCases = [
  {
    file: gpuTexturesFile,
    fullName: 'uploads odd-stride dirty rectangles to two layers of each growing texture array',
    sourceKey: 'src/render/webgpu/gpu-textures.browser.test.ts:62:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: gpuTexturesFile,
    fullName: 'rejects a layer capacity above the adapter limit before allocating textures',
    sourceKey: 'src/render/webgpu/gpu-textures.browser.test.ts:91:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: gpuTexturesFile,
    fullName:
      'starts each kind at one layer and preserves existing pixels when only grayscale grows',
    sourceKey: 'src/render/webgpu/gpu-textures.browser.test.ts:99:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
