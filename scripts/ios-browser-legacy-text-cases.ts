import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const legacyTextFile = fileURLToPath(
  new URL('../bench/comparison-legacy-text.browser.test.ts', import.meta.url),
)

export const legacyTextCases = [
  {
    file: legacyTextFile,
    fullName: 'observes the clusters drawn by pinned ghostty-web after the ASCII control',
    sourceKey: 'bench/comparison-legacy-text.browser.test.ts:18:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: legacyTextFile,
    fullName: 'reads the active rendered rows after history grows',
    sourceKey: 'bench/comparison-legacy-text.browser.test.ts:37:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
