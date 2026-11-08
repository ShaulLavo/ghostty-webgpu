import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const canvasRasterizerFile = fileURLToPath(
  new URL('../src/render/shared/atlas/canvas-rasterizer.browser.test.ts', import.meta.url),
)

export const canvasRasterizerCases = [
  {
    file: canvasRasterizerFile,
    fullName: 'keeps alphabetic glyphs on one stable cell-relative baseline',
    sourceKey: 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts:84:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasRasterizerFile,
    fullName: 'crops actual ink, preserves span identity, and skips empty glyphs',
    sourceKey: 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts:94:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasRasterizerFile,
    fullName: 'separates regular, bold, italic, and bold-italic cache identities',
    sourceKey: 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts:107:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasRasterizerFile,
    fullName: 'bounds unique glyph retention while keeping recently reused glyphs',
    sourceKey: 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts:121:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasRasterizerFile,
    fullName: 'bounds cached pixel memory before the glyph count limit at high DPR',
    sourceKey: 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts:135:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasRasterizerFile,
    fullName: 'stores monochrome coverage in one byte and actual colored output in RGBA',
    sourceKey: 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts:154:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasRasterizerFile,
    fullName: 'uses configured numeric regular and bold weights while italic remains cell-driven',
    sourceKey: 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts:165:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasRasterizerFile,
    fullName:
      'places glyphs from fitted positive and safe negative letter spacing at every target DPR',
    sourceKey: 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts:177:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
