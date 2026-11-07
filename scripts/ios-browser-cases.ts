import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const viewportFile = fileURLToPath(
  new URL('../src/dom/tests/viewport.browser.test.ts', import.meta.url),
)

export const viewportCases = [
  {
    file: viewportFile,
    fullName:
      'saved terminal viewport > repaints native colors, attributes, wide cells and cursor without a terminal',
    sourceKey: 'src/dom/tests/viewport.browser.test.ts:66:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: viewportFile,
    fullName: 'saved terminal viewport > preserves content geometry inside a padded host',
    sourceKey: 'src/dom/tests/viewport.browser.test.ts:88:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: viewportFile,
    fullName:
      'saved terminal viewport > captures only submitted revisions and reports the frame after writes',
    sourceKey: 'src/dom/tests/viewport.browser.test.ts:106:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: viewportFile,
    fullName:
      'saved terminal viewport > preserves the scrolled viewport and its position for live handoff',
    sourceKey: 'src/dom/tests/viewport.browser.test.ts:119:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: viewportFile,
    fullName:
      'saved terminal viewport > rejects stale geometry, DPR, appearance, malformed and oversized data',
    sourceKey: 'src/dom/tests/viewport.browser.test.ts:130:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
