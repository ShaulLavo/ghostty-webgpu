import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const webgpuFile = fileURLToPath(
  new URL('../src/render/tests/webgpu.browser.test.ts', import.meta.url),
)

export const webgpuCases = [
  {
    file: webgpuFile,
    fullName: 'creates a WebGPU device, submits a frame, and reads pixels back',
    sourceKey: 'src/render/tests/webgpu.browser.test.ts:75:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: webgpuFile,
    fullName: 'rasterizes and uploads grayscale and color atlas pages',
    sourceKey: 'src/render/tests/webgpu.browser.test.ts:83:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
