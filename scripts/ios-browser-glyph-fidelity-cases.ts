import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const glyphFidelityFile = fileURLToPath(
  new URL('../src/render/tests/glyph-fidelity.browser.test.ts', import.meta.url),
)

export const glyphFidelityCases = [
  {
    file: glyphFidelityFile,
    fullName:
      'keeps alphabetic glyphs and digits on a stable baseline while preserving punctuation and descenders',
    sourceKey: 'src/render/tests/glyph-fidelity.browser.test.ts:82:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: glyphFidelityFile,
    fullName: 'covers combining text, CJK, and emoji without changing their requested cell span',
    sourceKey: 'src/render/tests/glyph-fidelity.browser.test.ts:97:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: glyphFidelityFile,
    fullName: 'keeps native wide continuation ownership and transparent cell semantics',
    sourceKey: 'src/render/tests/glyph-fidelity.browser.test.ts:110:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: glyphFidelityFile,
    fullName: 'fits fractional DPR inputs to one drift-free character and cell grid',
    sourceKey: 'src/render/tests/glyph-fidelity.browser.test.ts:135:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
