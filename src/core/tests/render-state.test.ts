import { afterEach, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

describe('render row reads', () => {
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
