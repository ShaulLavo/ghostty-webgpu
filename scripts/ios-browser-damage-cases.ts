import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const pixelDamageFile = fileURLToPath(
  new URL('../src/render/pixels/damage.browser.test.ts', import.meta.url),
)

export const pixelDamageCases = [
  {
    file: pixelDamageFile,
    fullName: 'uploads only warm edited pixel columns at DPR 1 with exact RGBA',
    sourceKey: 'src/render/pixels/damage.browser.test.ts:19:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelDamageFile,
    fullName: 'uploads only warm edited pixel columns at DPR 1.25 with exact RGBA',
    sourceKey: 'src/render/pixels/damage.browser.test.ts:19:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelDamageFile,
    fullName: 'uploads only warm edited pixel columns at DPR 1.5 with exact RGBA',
    sourceKey: 'src/render/pixels/damage.browser.test.ts:19:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelDamageFile,
    fullName: 'uploads only warm edited pixel columns at DPR 2 with exact RGBA',
    sourceKey: 'src/render/pixels/damage.browser.test.ts:19:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelDamageFile,
    fullName: 'preserves pixel-scroll full-repaint RGBA with an inherited output filter',
    sourceKey: 'src/render/pixels/damage.browser.test.ts:150:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
