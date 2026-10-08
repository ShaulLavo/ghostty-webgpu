import { afterEach, describe, expect, it, vi } from 'vitest'
import { GhosttyResult, RenderStateDirty } from '../abi.js'
import { GhosttyRuntime } from '../runtime.js'
import { TextRowReader } from '../text-row-reader.js'
import type { RenderRow, RenderTextRow } from '../types.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  vi.restoreAllMocks()
  runtime?.dispose()
  runtime = undefined
})

function equivalentTextRows(rows: readonly RenderRow[]): readonly RenderTextRow[] {
  return rows.map((row) => {
    const cells = row.cells.map((cell) => cell.text)
    const continuations = row.cells.map((cell) => cell.continuation)
    let text = ''
    for (const cell of row.cells) text += cell.continuation ? '' : cell.text || ' '
    return { y: row.y, text, cells, continuations }
  })
}

function materialize(rows: readonly RenderTextRow[]): readonly RenderTextRow[] {
  return rows.map(({ y, text, cells, continuations }) => ({ y, text, cells, continuations }))
}

describe('text-only render rows', () => {
  it('advances snapshotVersion on damaged updates and preserves it across reads and clean updates', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 10, rows: 2 })
    const state = runtime.createRenderState(terminal)
    expect(state.snapshotVersion).toBe(0)
    expect(state.update()).toBe(RenderStateDirty.Full)
    expect(state.snapshotVersion).toBe(1)
    state.readRows()
    state.readTextRows()
    state.readCursor()
    expect(state.snapshotVersion).toBe(1)
    state.acknowledge()
    expect(state.snapshotVersion).toBe(1)
    expect(state.update()).toBe(RenderStateDirty.False)
    expect(state.snapshotVersion).toBe(1)
    terminal.write('changed')
    expect(state.snapshotVersion).toBe(1)
    expect(state.update()).not.toBe(RenderStateDirty.False)
    expect(state.snapshotVersion).toBe(2)
    state.readRows({ packed: true })
    state.readTextRows({ dirtyOnly: true })
    state.acknowledge()
    expect(state.snapshotVersion).toBe(2)
    expect(state.update()).toBe(RenderStateDirty.False)
    expect(state.snapshotVersion).toBe(2)
  })

  it('reads an immutable empty snapshot before update and rejects disposed state', async () => {
    runtime = await GhosttyRuntime.create()
    const state = runtime.createRenderState(runtime.createTerminal())
    const rows = state.readTextRows()
    expect(rows).toEqual([])
    expect(Object.isFrozen(rows)).toBe(true)
    state.dispose()
    expect(() => state.readTextRows()).toThrowError(
      expect.objectContaining({ operation: 'render_state' }),
    )
  })

  it('matches full native rows for Unicode, wrapping, styles, and screen transitions', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 17, rows: 5 })
    const state = runtime.createRenderState(terminal)
    const texts = [
      'plain',
      'é',
      'é',
      ' ́',
      '界',
      '👩‍💻',
      '👨‍👩‍👧‍👦',
      '𐐀',
      '🏳️‍🌈',
      '🇺🇦',
      '👍🏽',
      '❤️',
      'x' + '́'.repeat(80),
      ' ',
    ]
    let seed = 0x283
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    for (let screen = 0; screen < 20; screen += 1) {
      terminal.write('\x1b[?2027h\x1b[0m\x1b[2J\x1b[H')
      for (const value of texts) {
        terminal.write(
          `\x1b[${random(5) + 1};${random(17) + 1}H\x1b[1;3;4;7;38;2;10;20;30;48;5;123m${value}`,
        )
      }
      terminal.write('\x1b[5;17H界')
      if (screen % 2 === 0) terminal.selectAll()
      else terminal.clearSelection()
      state.update()
      expect(materialize(state.readTextRows())).toEqual(equivalentTextRows(state.readRows()))
      state.acknowledge()
    }
    for (const sequence of [
      '\x1b[?1049h👩‍💻界é',
      '\x1b[?1049l',
      '\x1b[0m\x1b[H\x1b[2J',
      'first\r\nsecond\r\nthird\r\nfourth\r\nfifth\r\nsixth',
    ]) {
      terminal.write(sequence)
      state.update()
      expect(materialize(state.readTextRows())).toEqual(equivalentTextRows(state.readRows()))
    }
    terminal.scrollToTop()
    state.update()
    expect(materialize(state.readTextRows())).toEqual(equivalentTextRows(state.readRows()))
    terminal.scrollToBottom()
    state.update()
    expect(materialize(state.readTextRows())).toEqual(equivalentTextRows(state.readRows()))
  })

  it('batches ASCII row text while preserving lazy cells across later native updates', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 80, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('first plain row\r\nsecond plain row\r\nthird plain row')
    state.update()
    const expected = equivalentTextRows(state.readRows())
    const decode = vi.spyOn(String, 'fromCodePoint')
    const batch = vi.spyOn(TextDecoder.prototype, 'decode')
    const rows = state.readTextRows()
    const calls = decode.mock.calls.length
    const batches = batch.mock.calls.length
    decode.mockRestore()
    batch.mockRestore()
    expect(calls).toBeLessThanOrEqual(rows.length)
    expect(batches).toBeLessThanOrEqual(1)
    expect(rows.map((row) => row.text)).toEqual(expected.map((row) => row.text))
    terminal.write('\x1b[H\x1b[2Jchanged')
    state.update()
    state.readTextRows()
    runtime.exports.memory.grow(1)
    expect(materialize(rows)).toEqual(expected)
    expect(structuredClone(rows)).toEqual(expected)
  })

  it('uses native grapheme records without allocating an ASCII bitmap', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('日本語 👩‍💻 é\r\n界 👨‍👩‍👧‍👦')
    state.update()
    const expected = equivalentTextRows(state.readRows())
    state.readTextRows()
    let allocations = 0
    vi.stubGlobal(
      'Uint32Array',
      new Proxy(Uint32Array, {
        construct(target, args, newTarget) {
          if (typeof args[0] === 'number') allocations += 1
          return Reflect.construct(target, args, newTarget)
        },
      }),
    )
    let rows: readonly RenderTextRow[]
    try {
      rows = state.readTextRows()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(allocations).toBe(0)
    expect(materialize(rows)).toEqual(expected)
    terminal.write('\x1b[H\x1b[2Jchanged')
    state.update()
    state.readTextRows()
    runtime.exports.memory.grow(1)
    expect(structuredClone(rows)).toEqual(expected)
  })

  it('filters requested and dirty rows without updating or acknowledging the state', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 10, rows: 4 })
    const state = runtime.createRenderState(terminal)
    terminal.write('first\r\nsecond')
    state.update()
    state.acknowledge()
    terminal.write('\x1b[3;1Hthird')
    expect(state.readTextRows({ dirtyOnly: true })).toEqual([])
    expect(state.readTextRows()[2]!.text).toBe(' '.repeat(10))
    state.update()
    const dirty = state.dirty
    const dirtyRows = state.readRows({ dirtyOnly: true }).map((row) => row.y)
    const options = { dirtyOnly: true, rows: new Set([-1, 0, 2, 4, 1.5, NaN]) }
    expect(materialize(state.readTextRows(options))).toEqual(
      equivalentTextRows(state.readRows(options)),
    )
    expect(state.readTextRows(options).map((row) => row.y)).toEqual([2])
    expect(state.dirty).toBe(dirty)
    expect(state.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual(dirtyRows)
    expect(state.readTextRows({ rows: new Set() })).toEqual([])
    expect(state.readTextRows({ rows: new Set([0, 2]) }).map((row) => row.y)).toEqual([0, 2])
    expect(state.acknowledge()).toBe(dirtyRows.length)
    expect(state.readTextRows({ dirtyOnly: true })).toEqual([])
  })

  it('keeps lazy immutable cell arrays owned across growth, reader reuse, resize, and disposal', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[?2027h\x1b[1;38;2;10;20;30m👩‍💻界é')
    state.update()
    const expected = equivalentTextRows(state.readRows())
    const from = vi.spyOn(Array, 'from')
    const rows = state.readTextRows()
    const eagerArrays = from.mock.calls.length
    from.mockRestore()
    expect(eagerArrays).toBe(0)
    expect(Object.isFrozen(rows)).toBe(true)
    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true)
      expect(typeof Object.getOwnPropertyDescriptor(row, 'cells')?.get).toBe('function')
      expect(typeof Object.getOwnPropertyDescriptor(row, 'continuations')?.get).toBe('function')
    }
    runtime.exports.memory.grow(1)
    terminal.resize({ columns: 30, rows: 5 })
    terminal.write('\x1b[Hchanged')
    state.update()
    state.readTextRows()
    terminal.resize({ columns: 4, rows: 1 })
    state.update()
    state.readTextRows()
    state.dispose()
    terminal.dispose()
    runtime.dispose()
    expect(materialize(rows)).toEqual(expected)
    for (const row of rows) {
      expect(Object.isFrozen(row.cells)).toBe(true)
      expect(Object.isFrozen(row.continuations)).toBe(true)
      expect(row.cells).toBe(row.cells)
      expect(row.continuations).toBe(row.continuations)
    }
  })

  it('uses compact text records and retries the grapheme pool once without full-row extraction', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 10, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[?2027he' + '́'.repeat(60))
    state.update()
    const full = vi.spyOn(runtime.bridge, 'readRows')
    const text = runtime.bridge.readTextRows.bind(runtime.bridge)
    let calls = 0
    let rowStride = 0
    let cellBytes = 0
    runtime.bridge.readTextRows = (...args) => {
      calls += 1
      const pointer = args[6]
      const view = runtime!.memory.view
      rowStride = (view.getUint32(pointer + 12, true) - view.getUint32(pointer, true)) / 3
      cellBytes = view.getUint32(pointer + 16, true) * 3 * 4
      return text(...args)
    }
    const rows = state.readTextRows()
    expect(calls).toBe(2)
    expect(full).not.toHaveBeenCalled()
    expect(rowStride).toBe(12)
    expect(cellBytes).toBe(10 * 3 * 12)
    expect(rows[0]!.cells[0]).toBe('e' + '́'.repeat(60))
    calls = 0
    expect(materialize(state.readTextRows())).toEqual(materialize(rows))
    expect(calls).toBe(1)
  })

  it.each([
    { columns: 0, rows: 2 },
    { columns: 4, rows: 1 },
  ])('reports row/cell capacity shortfalls (%j)', async (grid) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
    const state = runtime.createRenderState(terminal)
    let handles: number[] = []
    const text = runtime.bridge.readTextRows.bind(runtime.bridge)
    runtime.bridge.readTextRows = (...args) => {
      handles = args
      return text(...args)
    }
    terminal.write('test')
    state.update()
    state.readTextRows()
    const reader = new TextRowReader(runtime)
    try {
      expect(() => reader.read(handles[0]!, handles[1]!, handles[2]!, grid, {})).toThrowError(
        expect.objectContaining({
          operation: 'bridge_read_text_rows',
          result: GhosttyResult.OutOfSpace,
        }),
      )
    } finally {
      reader.dispose()
    }
  })
})
