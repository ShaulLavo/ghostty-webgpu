import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const sharedAtlasFile = fileURLToPath(
  new URL('../src/render/tests/shared-atlas.browser.test.ts', import.meta.url),
)

export const sharedAtlasCases = [
  {
    file: sharedAtlasFile,
    fullName:
      'shares one atlas texture set between terminals with equal fonts and keeps their pixels',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:230:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'moves only the terminal whose font changes and leaves its peers drawing the shared atlas',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:244:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'rebuilds a sharing terminal from its own eviction queue after a peer clears the atlas',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:264:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'restores one terminal on a replacement device while its peer keeps the original device',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:276:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName: 'keeps different DPR and font descriptors in different atlas sets',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:294:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName: 'releases textures only when the last sharing terminal is disposed',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:304:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'keeps the previous texture alive through growth until the coordinator submits its peer',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:328:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'keeps the previous texture alive through invalidation until the coordinator submits its peer',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:328:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'restores all sharing terminals after real device loss with one fresh texture generation',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:398:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName: 'keeps the prior font and releases a new owner when font texture allocation fails',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:415:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'releases retired textures when the invalidating sharer disposes before repaint and its peer stays idle',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:433:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'releases idle-device textures during growth while another device has an encoded frame',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:460:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName:
      'releases idle-device textures during invalidation while another device has an encoded frame',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:460:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName: 'keeps the final device lease alive until its encoded owner is submitted',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:512:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName: 'keeps the final device lease alive until its encoded owner is failed',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:512:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: sharedAtlasFile,
    fullName: 'keeps the final device lease alive until its encoded owner is detached',
    sourceKey: 'src/render/tests/shared-atlas.browser.test.ts:512:2',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
