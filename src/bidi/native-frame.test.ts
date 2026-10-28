import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { GhosttyRuntime } from '../core/runtime.js'
import { bidiProjection, RowBidiMapper } from './row.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../render/shared/config.js'

const active: GhosttyRuntime[] = []
afterEach(() => {
  for (const runtime of active.splice(0)) runtime.dispose()
})
const fixtures = [
  ['hebrew-mixed', [0, 1, 2, 6, 5, 4, 3, 7, 8, 9]],
  ['hebrew-numbers', [7, 6, 5, 3, 4, 2, 1, 0]],
  ['hebrew-punctuation', [4, 3, 2, 1, 0]],
  ['arabic', [5, 6, 7, 4, 3, 2, 1, 0]],
  ['wide-emoji', [0, 4, 2, 3, 1, 5]],
] as const

describe('native projected frame', () => {
  it.each(fixtures)('paints logical %s cells at visual columns', async (name, expected) => {
    const runtime = await GhosttyRuntime.create()
    active.push(runtime)
    const terminal = runtime.createTerminal({ columns: 40, rows: 8 })
    const source = runtime.createRenderState(terminal)
    terminal.write(
      readFileSync(new URL(`../../bench/fixtures/correctness/bidi-${name}.vt`, import.meta.url)),
    )
    source.update()
    const logical = source.readRows()
    const builder = source.createFrameBuilder(40, 8)
    const projection = vi.fn(() => bidiProjection(logical, new RowBidiMapper()))
    builder.setBidiProjection(projection)
    const options = {
      cellWidth: 10,
      cellHeight: 20,
      theme: canonicalRendererTheme(mergeRendererTheme(undefined)),
      full: false,
      stableRows: true,
      overlayRows: new Set<number>(),
    }
    expect(builder.build(options)).toBe(2)
    const glyphs = builder.missingGlyphs.map((key) => ({ key, input: builder.glyphInput(key) }))
    for (const { key } of glyphs)
      builder.registerGlyph(key, {
        key: 'test',
        kind: 'grayscale',
        offsetX: 0,
        offsetY: 0,
        width: 1,
        height: 1,
        x: 0,
        y: 0,
        atlasWidth: 1,
        atlasHeight: 1,
        layer: 0,
        generation: 1,
      })
    expect(builder.build(options)).toBe(0)
    expect(projection).toHaveBeenCalledTimes(2)
    expect(builder.stableRows).toBe(false)
    for (const [visual, logical] of expected.entries()) {
      if (name === 'wide-emoji' && logical === 3) continue
      expect(builder.glyphData[visual * 24]).toBe(visual * 10)
    }
    if (name === 'hebrew-punctuation')
      expect(glyphs.map((glyph) => glyph.input.text)).toEqual(['א', ')', 'ב', '(', 'ג'])
    if (name === 'arabic')
      expect(glyphs.every((glyph) => Array.from(glyph.input.text).length === 1)).toBe(true)
    expect(source.readRows()).toEqual(logical)
    builder.dispose()
  })
})
