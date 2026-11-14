import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const textPassFile = fileURLToPath(
  new URL('../src/render/tests/text-pass.browser.test.ts', import.meta.url),
)

export const textPassCases = [
  {
    file: textPassFile,
    fullName: 'binds the small grid on default device limits',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:106:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'binds the largest grid in the packed binding budg… on default device limits',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:106:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'renders transparent defaults, opaque explicit colors, glyphs, and an outline cursor',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:307:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'renders identical native glyph pixels across bounded storage batches',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:334:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'renders explicit cursor text over a WebGPU block cursor',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:349:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName:
      'renders decorations, inverse, selection, invisibility, and minimum contrast in shader',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:380:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'selects the native color-atlas kind alongside grayscale glyphs',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:424:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'renders identical atlas coordinates from two layers in one two-draw frame',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:457:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'remaps physical storage rows with exact pixels after ring wrap and regional moves',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:501:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
