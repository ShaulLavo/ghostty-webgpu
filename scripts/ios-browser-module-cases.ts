import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const moduleMockFile = fileURLToPath(
  new URL('../src/dom/tests/module-mock.browser.test.ts', import.meta.url),
)

export const moduleMockCases = [
  {
    file: moduleMockFile,
    fullName: 'intercepts a third-party browser module while its real exports remain observable',
    sourceKey: 'src/dom/tests/module-mock.browser.test.ts:6:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
