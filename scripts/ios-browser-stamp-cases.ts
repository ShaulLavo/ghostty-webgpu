import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const stampCacheFile = fileURLToPath(
  new URL('../src/render/pixels/stamp-cache.browser.test.ts', import.meta.url),
)

export const stampCacheCases = [
  {
    file: stampCacheFile,
    fullName:
      'Canvas resident stamp cache > does zero raster/readback/stamp-copy work for a repeated warm request',
    sourceKey: 'src/render/pixels/stamp-cache.browser.test.ts:51:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: stampCacheFile,
    fullName:
      'Canvas resident stamp cache > qualifies actual requested-brush A8 bytes and preserves intrinsic RGBA exactly',
    sourceKey: 'src/render/pixels/stamp-cache.browser.test.ts:71:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: stampCacheFile,
    fullName:
      'Canvas resident stamp cache > keys brush, alpha, font, span, phase, geometry, browser and font lifetime',
    sourceKey: 'src/render/pixels/stamp-cache.browser.test.ts:88:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: stampCacheFile,
    fullName:
      'Canvas resident stamp cache > retains only offsets across ordinary memory growth and invalidates on clear/dispose',
    sourceKey: 'src/render/pixels/stamp-cache.browser.test.ts:110:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: stampCacheFile,
    fullName:
      'Canvas resident stamp cache > bounds residency by viewport extent and evicts the least-recently used stamp',
    sourceKey: 'src/render/pixels/stamp-cache.browser.test.ts:133:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: stampCacheFile,
    fullName:
      'Canvas resident stamp cache > does not commit a failed raster or stamp copy and permits a clean retry',
    sourceKey: 'src/render/pixels/stamp-cache.browser.test.ts:151:2',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
