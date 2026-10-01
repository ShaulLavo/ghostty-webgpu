import { expect, it } from 'vitest'
import { GhosttyRuntime } from '../../../core/runtime.js'
import { GlyphAtlas } from '../../atlas/atlas.js'
import type { GlyphRasterizationInput } from '../../atlas/types.js'
import { canonicalRendererTheme } from '../../config.js'
import { InstanceRows } from '../rows.js'
import { defaultRendererTheme } from '../types.js'

it('builds identical instances directly from packed rows without materializing cells', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 24, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write(
      '\x1b[?2027h\x1b[1;3;4:3;9;53;38;2;10;20;30;48;2;40;50;60mAé界👩‍💻é\x1b[0m\r\nplain\x1b[7m inverse\x1b[0m\r\n\x1b[2;8mhidden',
    )
    terminal.selectAll()
    state.update()
    const packed = state.readRows({ packed: true })
    const decoded = state.readRows()
    const theme = canonicalRendererTheme(defaultRendererTheme)
    const options = { cellHeight: 16, cellWidth: 8, columns: 24, rows: 3 }
    const actual = new InstanceRows(options)
    const expected = new InstanceRows(options)
    const actualAtlas = new GlyphAtlas({ pageHeight: 128, pageWidth: 128 })
    const expectedAtlas = new GlyphAtlas({ pageHeight: 128, pageWidth: 128 })
    const source = {
      rasterize(input: GlyphRasterizationInput) {
        const width = 8 * input.cellSpan
        return {
          height: 12,
          kind: 'grayscale' as const,
          offsetX: 0,
          offsetY: 1,
          pixels: new Uint8Array(width * 12).fill(255),
          width,
        }
      },
    }
    const lookup = (atlas: GlyphAtlas) => ({
      beginRow: (y: number) => atlas.beginRow(y),
      resolve: (key: string, bitmap: ReturnType<typeof source.rasterize>, y: number) =>
        atlas.getOrInsert(key, bitmap, y),
    })
    for (const row of packed) {
      Object.defineProperty(row, 'cells', {
        get() {
          throw new TypeError('Packed instance building materialized cells')
        },
      })
      const cursor = { visible: true, x: 3, y: row.y, style: 'block' as const }
      expect(actual.rebuildRow(row, lookup(actualAtlas), source, theme, cursor)).toEqual(
        expected.rebuildRow(decoded[row.y]!, lookup(expectedAtlas), source, theme, cursor),
      )
    }
    expect(actual.cellData).toEqual(expected.cellData)
    expect(actual.glyphData).toEqual(expected.glyphData)
  } finally {
    runtime.dispose()
  }
})
