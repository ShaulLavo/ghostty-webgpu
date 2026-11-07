import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const measurementFile = fileURLToPath(
  new URL('../src/dom/tests/measurement.browser.test.ts', import.meta.url),
)

export const measurementCases = [
  {
    file: measurementFile,
    fullName: 'public native width and geometry hooks > measures a readonly batch through the public entry and live native modes',
    sourceKey: 'src/dom/tests/measurement.browser.test.ts:26:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: measurementFile,
    fullName: 'public native width and geometry hooks > publishes ordinary write geometry before public title observers',
    sourceKey: 'src/dom/tests/measurement.browser.test.ts:45:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: measurementFile,
    fullName: 'public native width and geometry hooks > publishes ordinary write geometry before public data observers',
    sourceKey: 'src/dom/tests/measurement.browser.test.ts:45:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: measurementFile,
    fullName: 'public native width and geometry hooks > captures the native colored prompt origin before host title observers run',
    sourceKey: 'src/dom/tests/measurement.browser.test.ts:61:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
