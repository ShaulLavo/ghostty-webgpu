import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const captureControlFile = fileURLToPath(
  new URL('./ios-browser-capture-control.browser.test.ts', import.meta.url),
)
export const captureControlCases = [
  {
    file: captureControlFile,
    fullName:
      'native enclosing capture controls > captures fractional asymmetric edges and sRGB patches',
    sourceKey: 'scripts/ios-browser-capture-control.browser.test.ts:62:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: captureControlFile,
    fullName:
      'native enclosing capture controls > captures integer asymmetric edges and sRGB patches',
    sourceKey: 'scripts/ios-browser-capture-control.browser.test.ts:65:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: captureControlFile,
    fullName: 'native enclosing capture controls > brings a fitting offscreen element into view',
    sourceKey: 'scripts/ios-browser-capture-control.browser.test.ts:68:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: captureControlFile,
    fullName: 'native enclosing capture controls > captures with a stable tester scroll position',
    sourceKey: 'scripts/ios-browser-capture-control.browser.test.ts:71:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: captureControlFile,
    fullName:
      'native enclosing capture controls > preserves the unchanged displayedPixels helper on asymmetric pixels',
    sourceKey: 'scripts/ios-browser-capture-control.browser.test.ts:75:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
