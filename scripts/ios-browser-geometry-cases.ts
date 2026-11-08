import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const fontGeometryFile = fileURLToPath(
  new URL('../src/dom/tests/font-geometry.browser.test.ts', import.meta.url),
)

export const fontGeometryCases = [
  {
    file: fontGeometryFile,
    fullName: 'fits the loaded font box before line-height and device-pixel rounding',
    sourceKey: 'src/dom/tests/font-geometry.browser.test.ts:32:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: fontGeometryFile,
    fullName:
      'keeps the mounted Canvas grid, backing, and painted row boundaries in the fitted units',
    sourceKey: 'src/dom/tests/font-geometry.browser.test.ts:60:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: fontGeometryFile,
    fullName:
      'derives the pinned ghostty-web cell from M ink bounds and its fixed two-pixel padding',
    sourceKey: 'src/dom/tests/font-geometry.browser.test.ts:117:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
