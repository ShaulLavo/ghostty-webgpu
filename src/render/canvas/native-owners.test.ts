import { afterEach, describe, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import { CanvasRowPainter } from './painter.js'
import type { PaintTarget } from './paint-target.js'
import { fittedFont } from './tests/font.js'

let runtime: GhosttyRuntime | undefined
afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

function target() {
  return {
    fillText: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    globalAlpha: 1,
    lineWidth: 1,
    textAlign: 'center',
    textBaseline: 'alphabetic',
  } satisfies PaintTarget
}

describe('Canvas native cell ownership', () => {
  it.each([false, true])(
    'keeps mode 2027=%s native text, continuations and cursor span',
    async (enabled) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
      const state = runtime.createRenderState(terminal)
      terminal.write(`\x1b[?2027${enabled ? 'h' : 'l'}\x1b[2;3H👩‍💻`)
      state.update()
      const row = state.readRows()[1]!
      expect(row.cells[2]!.text).toBe(enabled ? '👩‍💻' : '👩‍')
      expect(row.cells[3]!.continuation).toBe(true)
      expect(terminal.cursor.x).toBe(enabled ? 4 : 6)
      const context = target()
      const painter = new CanvasRowPainter(
        context,
        fittedFont(),
        canonicalRendererTheme(mergeRendererTheme({})),
      )
      painter.resetContext(fittedFont())
      painter.paint(row, undefined, 120)
      expect(context.fillText.mock.calls).toEqual(
        enabled
          ? [['👩‍💻', 30, 36]]
          : [
              ['👩‍', 30, 36],
              ['💻', 50, 36],
            ],
      )
      expect(state.readRows()[1]!.cells).toEqual(row.cells)
    },
  )

  it('retains combining text, wide spans and native style/brush boundaries', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 16, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[?2027lÁ界\x1b[1;3;38;2;31;73;121m👩‍\x1b[0m💻')
    state.update()
    const row = state.readRows()[0]!
    const context = target()
    const painter = new CanvasRowPainter(
      context,
      fittedFont(),
      canonicalRendererTheme(mergeRendererTheme({})),
    )
    painter.resetContext(fittedFont())
    painter.paint(row, undefined, 160)
    expect(context.fillText.mock.calls).toEqual([
      ['Á', 5, 16],
      ['界', 20, 16],
      ['👩‍', 40, 16],
      ['💻', 60, 16],
    ])
    expect(row.cells[3]!.style?.bold).toBe(true)
    expect(row.cells[3]!.style?.italic).toBe(true)
    expect(row.cells[3]!.foreground).toEqual({ r: 31, g: 73, b: 121 })
  })
})
