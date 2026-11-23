import { afterEach, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { probeInput } from '../dom/tests/probe.js'
import { snapshotRenderState } from './frame.js'
import { copiedFrameRow } from './frame-row.js'
import type { RendererFrameRow } from './types.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

function plainRow(row: RendererFrameRow) {
  return {
    cells: row.cells,
    continuations: row.continuations,
    renderCells: row.renderCells,
    text: row.text,
    y: row.y,
  }
}

it('snapshots packed rows with the same content as eagerly decoded rows', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 12, rows: 4 })
  const state = runtime.createRenderState(terminal)
  terminal.write(probeInput + '\x1b[3;1H\x1b[4;31mred\x1b[0m é😀\r\nplain ascii')
  const snapshot = snapshotRenderState(state)
  const eager = state.readRows().map(copiedFrameRow)
  expect(snapshot.rows.map(plainRow)).toEqual(eager.map(plainRow))
  expect(snapshot.rows[0]!.renderCells[0]!.style).toMatchObject({ bold: true })
  expect(snapshot.rows[2]!.renderCells[0]!.foreground).toBeDefined()
})

it('keeps packed snapshots frozen and independent of later terminal output', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
  const state = runtime.createRenderState(terminal)
  terminal.write(probeInput)
  const snapshot = snapshotRenderState(state)
  const before = JSON.stringify(snapshot.rows.map(plainRow))
  terminal.write('\x1b[2J\x1b[Hreplaced')
  snapshotRenderState(state)
  expect(JSON.stringify(snapshot.rows.map(plainRow))).toBe(before)
  const row = snapshot.rows[0]!
  for (const value of [snapshot, snapshot.rows, row, row.cells, row.continuations])
    expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(row.renderCells)).toBe(true)
  expect(Object.isFrozen(row.renderCells[0])).toBe(true)
  expect(Object.isFrozen(row.renderCells[0]!.foreground)).toBe(true)
  expect(row.renderCells).toBe(row.renderCells)
})
