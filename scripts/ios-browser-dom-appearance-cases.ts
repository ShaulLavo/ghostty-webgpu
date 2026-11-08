import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const domAppearanceFile = fileURLToPath(
  new URL('../src/render/dom/appearance-retention.browser.test.ts', import.meta.url),
)

export const domAppearanceCases = [
  {
    file: domAppearanceFile,
    fullName:
      'retains cursor appearance rows while publishing frames and observing current geometry',
    sourceKey: 'src/render/dom/appearance-retention.browser.test.ts:17:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
