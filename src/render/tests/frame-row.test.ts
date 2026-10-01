import { expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { copiedFrameRow } from '../frame-row.js'

it.each([
  '',
  '\x1b[?2027h\x1b[1;3;38;2;10;20;30mAé界👩‍💻é\x1b[0m\r\nplain\x1b[8mhidden',
  '\x1b]8;;https://example.com\x1b\\linked界\x1b]8;;\x1b\\\r\ne' + '́'.repeat(60),
])('copies frame text and continuations without materializing packed cells (%#)', async (text) => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 24, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write(text)
    terminal.selectAll()
    state.update()
    const packed = state.readRows({ packed: true })
    const decoded = state.readRows()
    const expected = decoded.map((row) => {
      const cells = row.cells.map((cell) => cell.text.slice())
      const continuations = row.cells.map((cell) => cell.continuation)
      const text = cells.map((cell, index) => (continuations[index] ? '' : cell || ' ')).join('')
      return { cells, continuations, text, y: row.y }
    })
    for (const row of packed) {
      Object.defineProperty(row, 'cells', {
        get() {
          throw new TypeError('Frame text extraction materialized packed cells')
        },
      })
    }
    const actual = packed.map(copiedFrameRow)
    expect(actual).toEqual(expected)
    expect(decoded.map(copiedFrameRow)).toEqual(expected)
    for (const row of actual) {
      expect(Object.isFrozen(row)).toBe(true)
      expect(Object.isFrozen(row.cells)).toBe(true)
      expect(Object.isFrozen(row.continuations)).toBe(true)
    }
    runtime.exports.memory.grow(1)
    terminal.resize({ columns: 4, rows: 1 })
    terminal.write('changed')
    state.update()
    state.readRows({ packed: true })
    expect(actual).toEqual(expected)
    expect(packed.map(copiedFrameRow)).toEqual(expected)
  } finally {
    runtime.dispose()
  }
})
