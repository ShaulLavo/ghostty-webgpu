import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const managedFallbackFile = fileURLToPath(
  new URL('../src/render/tests/fallback.browser.test.ts', import.meta.url),
)

export const managedFallbackCases = [
  {
    file: managedFallbackFile,
    fullName:
      'managed renderer fallback > replaces a lost WebGL canvas once and paints pending writes through the original callback',
    sourceKey: 'src/render/tests/fallback.browser.test.ts:93:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: managedFallbackFile,
    fullName:
      'managed renderer fallback > applies changes received during replacement before drawing and preserves hidden/focus state',
    sourceKey: 'src/render/tests/fallback.browser.test.ts:118:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: managedFallbackFile,
    fullName:
      'managed renderer fallback > disposes Canvas2D completing after dispose and leaves no scheduled work',
    sourceKey: 'src/render/tests/fallback.browser.test.ts:165:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: managedFallbackFile,
    fullName:
      'managed renderer fallback > disposes Canvas2D completing after abort and leaves no scheduled work',
    sourceKey: 'src/render/tests/fallback.browser.test.ts:165:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: managedFallbackFile,
    fullName:
      'managed renderer fallback > reports a failed replacement once without retrying or leaving scheduled work',
    sourceKey: 'src/render/tests/fallback.browser.test.ts:191:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: managedFallbackFile,
    fullName: 'reapplies reduced motion changed while a replacement renderer is opening',
    sourceKey: 'src/render/tests/fallback.browser.test.ts:211:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
