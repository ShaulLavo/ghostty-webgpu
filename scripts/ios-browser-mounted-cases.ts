import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const mountedScrollFile = fileURLToPath(
  new URL('../src/render/canvas/mounted-scroll.browser.test.ts', import.meta.url),
)

export const mountedScrollCases = [
  {
    file: mountedScrollFile,
    fullName: 'reuses rows after mounted public Terminal output scroll (canvas2d-fill-text)',
    sourceKey: 'src/render/canvas/mounted-scroll.browser.test.ts:53:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: mountedScrollFile,
    fullName: 'reuses rows after mounted public Terminal output scroll (canvas2d-pixels)',
    sourceKey: 'src/render/canvas/mounted-scroll.browser.test.ts:53:1',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
