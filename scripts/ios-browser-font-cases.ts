import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const fontResourcesFile = fileURLToPath(
  new URL('../src/dom/tests/font-resources.browser.test.ts', import.meta.url),
)

export const fontResourcesCases = [
  {
    file: fontResourcesFile,
    fullName: 'retires a pending font refresh after dispose',
    sourceKey: 'src/dom/tests/font-resources.browser.test.ts:12:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: fontResourcesFile,
    fullName: 'retires a pending font refresh after family-change',
    sourceKey: 'src/dom/tests/font-resources.browser.test.ts:12:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: fontResourcesFile,
    fullName: 'refreshes a failed matching load when completion events are missing',
    sourceKey: 'src/dom/tests/font-resources.browser.test.ts:47:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: fontResourcesFile,
    fullName: 'recognizes a cached face that settled before its loading event was delivered',
    sourceKey: 'src/dom/tests/font-resources.browser.test.ts:76:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: fontResourcesFile,
    fullName: 'does not rediscover a known family after an ordinary family change',
    sourceKey: 'src/dom/tests/font-resources.browser.test.ts:101:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
