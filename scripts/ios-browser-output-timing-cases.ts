import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const outputTimingFile = fileURLToPath(
  new URL('../src/dom/tests/output-timing.browser.test.ts', import.meta.url),
)

export const outputTimingCases = [
  {
    file: outputTimingFile,
    fullName: 'times auto output with frame presentation from input to the shown frame',
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:65:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: outputTimingFile,
    fullName: 'times auto output with immediate presentation from input to the shown frame',
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:65:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: outputTimingFile,
    fullName:
      'times canvas2d-fill-text output with frame presentation from input to the shown frame',
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:65:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: outputTimingFile,
    fullName:
      'times canvas2d-fill-text output with immediate presentation from input to the shown frame',
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:65:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: outputTimingFile,
    fullName: 'reports a later burst separately once output pauses',
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:97:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: outputTimingFile,
    fullName: "pairs output with typed input, not with the terminal's own replies",
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:113:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: outputTimingFile,
    fullName: 'forgets input once the last listener leaves',
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:128:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: outputTimingFile,
    fullName: 'records nothing while no one listens',
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:140:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: outputTimingFile,
    fullName: 'times worker output up to the frame notice',
    sourceKey: 'src/dom/tests/output-timing.browser.test.ts:152:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
