import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { GhosttyResult } from '../abi.js'
import { GhosttyError } from '../error.js'
import { emptyRenderCell } from '../packed-cells.js'
import { RowReader } from '../row-reader.js'
import { GhosttyRuntime } from '../runtime.js'
import { expectSnapshotTransitions } from './bulk-parity.js'
import { readPerCellRows } from './per-cell-reader.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

describe('bulk snapshots', () => {
  it('reads an empty snapshot before the first update', async () => {
    runtime = await GhosttyRuntime.create()
    const state = runtime.createRenderState(runtime.createTerminal())
    expect(state.readRows()).toEqual([])
    expect(state.readRows({ packed: true })).toEqual([])
  })

  it('matches the old per-cell reader on deterministic random screens', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 31, rows: 7 })
    const state = runtime.createRenderState(terminal)
    let handles: number[] = []
    const bulkRead = runtime.bridge.readRows.bind(runtime.bridge)
    runtime.bridge.readRows = (...args) => {
      handles = args
      return bulkRead(...args)
    }
    let seed = 0x283
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    const texts = ['A', 'é', '界', '👩‍💻', 'é', ' ', '𐐀', '👨‍👩‍👧‍👦', 'x' + '́'.repeat(60)]
    const styles = [
      '0',
      '1',
      '2',
      '3',
      '4',
      '4:2',
      '4:3',
      '4:4',
      '4:5',
      '5',
      '7',
      '8',
      '9',
      '53',
      '1;3;4;5;7;9;53',
    ]
    for (let screen = 0; screen < 40; screen += 1) {
      terminal.write('\x1b[?2027h\x1b[0m\x1b[2J\x1b[H')
      for (let index = 0; index < 90; index += 1) {
        const rgb = `${random(256)};${random(256)};${random(256)}`
        const colors = random(2)
          ? `38;2;${rgb};48;5;${random(256)}`
          : `38;5;${random(256)};48;2;${rgb}`
        terminal.write(
          `\x1b[${random(7) + 1};${random(31) + 1}H\x1b[0;${styles[random(styles.length)]};${colors}m${texts[random(texts.length)]}`,
        )
      }
      terminal.write('\x1b[0m\x1b[7;1H\x1b[48;5;123m\x1b[K\x1b[0m')
      if (screen % 2) terminal.selectAll()
      else terminal.clearSelection()
      if (screen % 5 === 0) terminal.scrollToTop()
      else terminal.scrollToBottom()
      state.update()
      const actual = state.readRows({ packed: true })
      const expected = readPerCellRows(runtime, handles[0]!, handles[1]!, handles[2]!)
      expect(actual.map(({ y, cells }) => ({ y, cells }))).toEqual(
        expected.map(({ y, cells }) => ({ y, cells })),
      )
      for (const row of actual) {
        const scratch = emptyRenderCell()
        for (let index = 0; index < row.cells.length; index += 1) {
          expect(row.packed!.read(index, scratch)).toEqual(row.cells[index])
        }
      }
      state.acknowledge()
    }
  })

  it('matches per-cell reads across default styles, palette changes, and screen switches', async () => {
    runtime = await GhosttyRuntime.create()
    expectSnapshotTransitions(runtime)
  })

  it.each([
    { columns: 0, rows: 2 },
    { columns: 4, rows: 1 },
  ])('reports row/cell capacity shortfalls as out of space (%j)', async (grid) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
    const state = runtime.createRenderState(terminal)
    let handles: number[] = []
    const bulkRead = runtime.bridge.readRows.bind(runtime.bridge)
    runtime.bridge.readRows = (...args) => {
      handles = args
      return bulkRead(...args)
    }
    terminal.write('test')
    state.update()
    state.readRows()
    const reader = new RowReader(runtime)
    try {
      expect(() => reader.read(handles[0]!, handles[1]!, handles[2]!, grid, {})).toThrowError(
        expect.objectContaining({
          name: GhosttyError.name,
          operation: 'bridge_read_rows',
          result: GhosttyResult.OutOfSpace,
          message: `bridge_read_rows failed: out of space (${GhosttyResult.OutOfSpace})`,
        }),
      )
    } finally {
      reader.dispose()
    }
  })

  it('retains owned packed rows across writes, growth, resize, and disposal', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[?2027h\x1b[1;38;2;10;20;30m👩‍💻界é')
    state.update()
    const rows = state.readRows({ packed: true })
    const expected = state.readRows()
    runtime.exports.memory.grow(1)
    terminal.resize({ columns: 4, rows: 1 })
    expect(state.readRows()).toEqual(expected)
    terminal.write('changed')
    state.update()
    state.readRows({ packed: true })
    state.dispose()
    terminal.dispose()
    expect(
      rows.map(({ y, dirty, packed }) => ({ y, dirty, cells: packed!.materialize() })),
    ).toEqual(expected)
    expect(rows.map(({ y, dirty, cells }) => ({ y, dirty, cells }))).toEqual(expected)
  })

  it('reads only damaged or requested rows and retries large grapheme buffers once', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 10, rows: 4 })
    const state = runtime.createRenderState(terminal)
    terminal.write('first\r\nsecond\x1b[3;1H')
    state.update()
    state.acknowledge()
    terminal.write('\x1b[3;1He' + '́'.repeat(60))
    state.update()
    const calls: number[] = []
    const readRows = runtime.bridge.readRows.bind(runtime.bridge)
    runtime.bridge.readRows = (...args) => {
      calls.push(1)
      return readRows(...args)
    }
    const damaged = state.readRows({ packed: true, dirtyOnly: true })
    expect(calls).toHaveLength(2)
    expect(damaged.map((row) => row.y)).toEqual([2])
    expect(damaged[0]!.cells[0]!.text).toBe('e' + '́'.repeat(60))
    calls.length = 0
    expect(state.readRows({ packed: true, rows: new Set([0, 2]) }).map((row) => row.y)).toEqual([
      0, 2,
    ])
    expect(calls).toHaveLength(1)
    expect(state.readRows({ packed: true, rows: new Set(), dirtyOnly: true })).toEqual([])
    state.acknowledge()
    expect(state.readRows({ packed: true, dirtyOnly: true })).toEqual([])
  })

  it('imports Ghostty memory without initializing or overwriting its contents', async () => {
    runtime = await GhosttyRuntime.create()
    const module = await WebAssembly.compile(
      await readFile(new URL('../../../bridge.wasm', import.meta.url)),
    )
    const before = runtime.memory.bytes.slice()
    await WebAssembly.instantiate(module, runtime.bridge.imports)
    expect(runtime.memory.bytes).toEqual(before)
    expect(WebAssembly.Module.imports(module)).toContainEqual({
      kind: 'memory',
      module: 'env',
      name: 'memory',
    })
  })
})
