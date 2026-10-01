import { expect } from 'vitest'
import { TerminalScreen } from '../abi.js'
import { emptyRenderCell } from '../packed-cells.js'
import type { GhosttyRuntime } from '../runtime.js'
import type { RenderRow } from '../types.js'
import { readPerCellRows } from './per-cell-reader.js'

function expectScratchCells(rows: readonly RenderRow[]): void {
  for (const row of rows) {
    const scratch = emptyRenderCell()
    for (let x = 0; x < row.cells.length; x += 1)
      expect(row.packed!.read(x, scratch)).toEqual(row.cells[x])
  }
}

export function expectSnapshotTransitions(runtime: GhosttyRuntime): void {
  const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
  const state = runtime.createRenderState(terminal)
  let handles: number[] = []
  const bulkRead = runtime.bridge.readRows.bind(runtime.bridge)
  runtime.bridge.readRows = (...args) => {
    handles = args
    return bulkRead(...args)
  }
  const transitions = [
    '\x1b[1;3;4mdefault\x1b[0m\r\n\x1b[38;5;123mpalette\x1b[0m',
    '\x1b]4;123;rgb:12/34/56\x1b\\',
    '\x1b[?1049h\x1b[H\x1b[1;3;4malternate\x1b[0m',
    '\x1b[?1049l',
  ]
  try {
    for (const [index, text] of transitions.entries()) {
      terminal.write(text)
      state.update()
      const actual = state.readRows({ packed: true, dirtyOnly: true })
      const expected = readPerCellRows(runtime, handles[0]!, handles[1]!, handles[2]!)
      expect(actual.length).toBeGreaterThan(0)
      expect(actual.map(({ y, cells }) => ({ y, cells }))).toEqual(
        expected
          .filter(({ y }) => actual.some((row) => row.y === y))
          .map(({ y, cells }) => ({ y, cells })),
      )
      expectScratchCells(actual)
      if (index === 0 || index === 2) {
        const styled = actual.find(({ y }) => y === 0)!.cells[0]!
        expect(styled.style).toMatchObject({ bold: true, italic: true, underline: 1 })
        expect(styled.foreground).toBeUndefined()
      }
      if (index === 1 || index === 3)
        expect(actual.find(({ y }) => y === 1)!.cells[0]!.foreground).toEqual({
          r: 0x12,
          g: 0x34,
          b: 0x56,
        })
      expect(terminal.activeScreen).toBe(
        index === 2 ? TerminalScreen.Alternate : TerminalScreen.Primary,
      )
      state.acknowledge()
    }
  } finally {
    runtime.bridge.readRows = bulkRead
    state.dispose()
    terminal.dispose()
  }
}
