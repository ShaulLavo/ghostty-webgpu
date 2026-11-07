import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const fontFixtureFile = fileURLToPath(
  new URL('../src/tests/fonts.browser.test.ts', import.meta.url),
)

export const fontFixtureCases = [
  {
    file: fontFixtureFile,
    fullName: 'serves the pinned browser fixture as a loadable WOFF2 font',
    sourceKey: 'src/tests/fonts.browser.test.ts:4:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
