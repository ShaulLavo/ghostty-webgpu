import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const atlasRegistryFile = fileURLToPath(
  new URL('../src/render/webgpu/atlas-registry.browser.test.ts', import.meta.url),
)

export const atlasRegistryCases = [
  {
    file: atlasRegistryFile,
    fullName:
      'reuses equal descriptors, keeps peers alive and removes listeners on the last release',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:43:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'isolates all fitted font fields and DPR while ignoring property insertion order',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:63:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'retires acquisitions on loading without mutating a live peer atlas',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:90:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'retires acquisitions on loadingdone without mutating a live peer atlas',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:90:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'retires acquisitions on loadingerror without mutating a live peer atlas',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:90:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'detects preloaded same-metric resource replacement before a new owner joins',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:103:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'isolates acquisition after a FontFace ascentOverride mutation',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:119:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'isolates acquisition after a FontFace descentOverride mutation',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:119:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'isolates acquisition after a FontFace lineGapOverride mutation',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:119:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'isolates acquisition after a FontFace display mutation',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:119:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: atlasRegistryFile,
    fullName: 'isolates acquisition after a FontFace sizeAdjust mutation',
    sourceKey: 'src/render/webgpu/atlas-registry.browser.test.ts:119:4',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
