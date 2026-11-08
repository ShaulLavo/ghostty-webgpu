import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const textPassFile = fileURLToPath(
  new URL('../src/render/tests/text-pass.browser.test.ts', import.meta.url),
)

export const textPassCases = [
  {
    file: textPassFile,
    fullName: 'binds the small grid on default device limits',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:104:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'binds the largest grid in the packed binding budget on default device limits',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:104:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'renders transparent defaults, opaque explicit colors, glyphs, and an outline cursor',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:305:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'renders identical native glyph pixels across bounded storage batches',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:332:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'renders explicit cursor text over a WebGPU block cursor',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:347:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName:
      'renders decorations, inverse, selection, invisibility, and minimum contrast in shader',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:378:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'selects the native color-atlas kind alongside grayscale glyphs',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:422:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'renders identical atlas coordinates from two layers in one two-draw frame',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:455:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: textPassFile,
    fullName: 'remaps physical storage rows with exact pixels after ring wrap and regional moves',
    sourceKey: 'src/render/tests/text-pass.browser.test.ts:499:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
