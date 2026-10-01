import { afterEach, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

describe('render row reads', () => {
  it('reuses memory views and refreshes them after growth between cell reads', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[38;2;10;20;30m\x1b[48;2;40;50;60m\x1b[1mAé界')
    state.update()
    const before = state.readRows()
    const bytes = runtime.memory.bytes
    const view = runtime.memory.view
    expect(runtime.memory.bytes).toBe(bytes)
    expect(runtime.memory.view).toBe(view)
    expect(before[0]!.cells[0]!.foreground).toEqual({ r: 10, g: 20, b: 30 })
    expect(before[0]!.cells[0]!.background).toEqual({ r: 40, g: 50, b: 60 })
    expect(before[0]!.cells[0]!.style?.bold).toBe(true)
    expect(before[0]!.cells.slice(0, 4).map((cell) => cell.text)).toEqual(['A', 'é', '界', ''])
    expect(before[0]!.cells[3]!.continuation).toBe(true)

    runtime.exports.memory.grow(1)
    expect(bytes.byteLength).toBe(0)
    expect(state.readRows()).toEqual(before)
    expect(runtime.memory.bytes === bytes).toBe(false)
    expect(runtime.memory.view === view).toBe(false)
    expect(runtime.memory.bytes.buffer).toBe(runtime.exports.memory.buffer)
    expect(runtime.memory.view.buffer).toBe(runtime.exports.memory.buffer)
    expect(runtime.memory.bytes).toBe(runtime.memory.bytes)
    expect(runtime.memory.view).toBe(runtime.memory.view)

    terminal.write('\x1b[0m\r\nnew')
    state.update()
    expect(
      state
        .readRows()[1]!
        .cells.slice(0, 3)
        .map((cell) => cell.text),
    ).toEqual(['n', 'e', 'w'])
  })

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
