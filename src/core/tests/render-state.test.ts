import { afterEach, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

describe('render row reads', () => {
  it('keeps ZWJ cell ownership and cursor widths in sync with mode 2027 across writes', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('👨‍👩‍👧‍👦')
    state.update()
    expect(
      state
        .readRows()[0]!
        .cells.filter((cell) => cell.text)
        .map((cell) => cell.text),
    ).toEqual(['👨‍', '👩‍', '👧‍', '👦'])
    expect(terminal.cursor.x).toBe(8)

    terminal.write('\x1b[?2027h\r\n')
    for (const codepoint of '👩‍💻👨‍👩‍👧‍👦') terminal.write(codepoint)
    state.update()
    const cells = state.readRows()[1]!.cells
    expect(cells[0]!.text).toBe('👩‍💻')
    expect(cells[1]!.continuation).toBe(true)
    expect(cells[2]!.text).toBe('👨‍👩‍👧‍👦')
    expect(cells[3]!.continuation).toBe(true)
    expect(terminal.cursor.x).toBe(4)

    terminal.write('\x1b[?2027l\r\n👩‍💻')
    state.update()
    expect(state.readRows()[2]!.cells[0]!.text).toBe('👩‍')
    expect(state.readRows()[2]!.cells[2]!.text).toBe('💻')
    expect(terminal.cursor.x).toBe(4)
  })

  it('selects viewport rows without changing their indices or acknowledging damage', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 4 })
    const state = runtime.createRenderState(terminal)
    terminal.write('first\r\nsecond\r\nthird')
    state.update()
    const all = state.readRows()

    expect(state.readRows({ rows: new Set([2, 0]) })).toEqual([all[0], all[2]])
    expect(state.readRows({ rows: new Set() })).toEqual([])
    expect(state.readRows({ rows: new Set([-1, 4]) })).toEqual([])
    expect(state.readRows({ rows: new Set([1]), dirtyOnly: true })).toEqual([all[1]])
    expect(state.readRows()).toEqual(all)

    state.acknowledge()
    terminal.write('\x1b[2;1Hchanged')
    state.update()
    expect(state.readRows({ rows: new Set([0]), dirtyOnly: true })).toEqual([])
    expect(state.readRows({ rows: new Set([1]), dirtyOnly: true }).map((row) => row.y)).toEqual([1])
    expect(state.readRows({ rows: new Set([0]) }).map((row) => row.y)).toEqual([0])
  })
})
