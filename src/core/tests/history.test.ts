import { afterEach, describe, expect, it } from 'vitest'
import { TERMINAL_READ_LINES_MAX_ROWS } from '../grid-text.js'
import { GhosttyRuntime } from '../runtime.js'
import { GhosttySelectionGesture } from '../selection.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

describe('terminal history', () => {
  it('reads retained rows oldest-first after scrollback overflow', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    terminal.setScrollbackLimit(4)
    const written = Array.from({ length: 10000 }, (_, index) => `row-${index}`)
    terminal.write(written.join('\r\n'))

    expect(terminal.totalRows).toBeLessThan(written.length)
    expect(terminal.scrollbackLength).toBeGreaterThan(0)
    expect(terminal.lineCount()).toBe(terminal.scrollbackLength + terminal.size.rows)
    const retained = written.slice(-terminal.lineCount())
    const lines = []
    for (let start = 0; start < terminal.lineCount(); start += TERMINAL_READ_LINES_MAX_ROWS) {
      lines.push(...terminal.readLines(start, terminal.lineCount()))
    }
    expect(lines).toEqual(retained.map((text) => ({ text, wrapped: false })))
    terminal.scrollToTop()
    expect(terminal.readLines(0, 1)).toEqual([{ text: retained[0], wrapped: false }])
    terminal.scrollToBottom()
    expect(terminal.readLines(0, 1)).toEqual([{ text: retained[0], wrapped: false }])
  })

  it('trims trailing written spaces by default and preserves them on request', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    terminal.write(' a  \r\n\r\n b')
    expect(terminal.readLines(0, 3)).toEqual([
      { text: ' a', wrapped: false },
      { text: '', wrapped: false },
      { text: ' b', wrapped: false },
    ])
    expect(terminal.readLines(0, 3, { trimRight: false })).toEqual([
      { text: ' a  ', wrapped: false },
      { text: '', wrapped: false },
      { text: ' b', wrapped: false },
    ])
  })

  it('keeps leading, interior, and trailing empty row indexes when native formatting omits the tail', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    terminal.write('\r\none\r\n\r\nfour\r\n\r\n')
    const expected = ['', 'one', '', 'four', '', ''].map((text) => ({ text, wrapped: false }))
    expect(terminal.readLines(0, Infinity)).toEqual(expected)
    expect(terminal.readLines(2, Infinity)).toEqual(expected.slice(2))
    expect(terminal.readLines(4, Infinity, { trimRight: false })).toEqual(expected.slice(4))
    terminal.selectAll()
    expect(
      terminal
        .readLines(1, 4, { trimRight: false })
        .map((line) => line.text)
        .join('\n'),
    ).toBe(terminal.getSelection({ trim: false, unwrap: false }))
  })

  it('preserves written spaces and complete combining-space graphemes through native range formatting', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    terminal.write('x ́  \r\n ́y \r\n  　')
    expect(terminal.readLines(0, 3)).toEqual([
      { text: 'x ́', wrapped: false },
      { text: ' ́y', wrapped: false },
      { text: '  　', wrapped: false },
    ])
    terminal.selectAll()
    expect(
      terminal
        .readLines(0, 3, { trimRight: false })
        .map((line) => line.text)
        .join('\n'),
    ).toBe(terminal.getSelection({ trim: false, unwrap: false }))
  })

  it('reads wide, combining, ZWJ, and large grapheme clusters without spacer cells', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
    const text = '界é👩‍💻'
    const large = `a${'́'.repeat(64)}`
    terminal.write(text)
    terminal.write(`\r\n${large}`)
    expect(terminal.readLines(0, 2)).toEqual([
      { text, wrapped: false },
      { text: large, wrapped: false },
    ])
    expect(terminal.readLines(0, 1, { trimRight: false })[0]?.text).toBe(text)
  })

  it('reports soft wraps and skips the spacer before a wrapped wide character', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 3 })
    terminal.write('abc界z')
    expect(terminal.readLines(0, 3)).toEqual([
      { text: 'abc', wrapped: true },
      { text: '界z', wrapped: false },
      { text: '', wrapped: false },
    ])
    expect(terminal.readLines(0, 2, { trimRight: false })).toEqual([
      { text: 'abc', wrapped: true },
      { text: '界z', wrapped: false },
    ])
  })

  it('reads only the active alternate screen and restores primary history on exit', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    terminal.write('one\r\ntwo\r\nthree\r\nfour')
    const primary = terminal.readLines(0, terminal.lineCount())
    expect(terminal.lineCount()).toBe(4)
    terminal.write('\u001b[?1049h\u001b[HALT')
    expect(terminal.lineCount()).toBe(3)
    expect(terminal.readLines(0, 10)).toEqual([
      { text: 'ALT', wrapped: false },
      { text: '', wrapped: false },
      { text: '', wrapped: false },
    ])
    terminal.write('\u001b[?1049l')
    expect(terminal.readLines(0, terminal.lineCount())).toEqual(primary)
  })

  it('clamps half-open bounds, truncates fractions, and rejects NaN', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    terminal.write('one\r\ntwo\r\nthree')
    expect(terminal.readLines(-10, 100)).toEqual(terminal.readLines(0, 3))
    expect(terminal.readLines(-Infinity, Infinity)).toEqual(terminal.readLines(0, 3))
    expect(terminal.readLines(1.9, 2.9)).toEqual([{ text: 'two', wrapped: false }])
    expect(terminal.readLines(2, 2)).toEqual([])
    expect(terminal.readLines(2, 1)).toEqual([])
    expect(terminal.readLines(100, 200)).toEqual([])
    expect(terminal.readLines(-2, -1)).toEqual([])
    expect(() => terminal.readLines(NaN, 2)).toThrow('Row index')
    expect(() => terminal.readLines(0, NaN)).toThrow('Row index')
  })

  it('caps each call and permits paging from any start index', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    terminal.write('x\r\n'.repeat(TERMINAL_READ_LINES_MAX_ROWS + 30))
    expect(terminal.lineCount()).toBeGreaterThan(TERMINAL_READ_LINES_MAX_ROWS)
    const first = terminal.readLines(0, Infinity)
    expect(first).toHaveLength(TERMINAL_READ_LINES_MAX_ROWS)
    expect(first.every((row) => row.text === 'x' && !row.wrapped)).toBe(true)
    expect(terminal.readLines(10, Infinity)).toHaveLength(TERMINAL_READ_LINES_MAX_ROWS)
    expect(terminal.readLines(TERMINAL_READ_LINES_MAX_ROWS, Infinity)).toHaveLength(
      terminal.lineCount() - TERMINAL_READ_LINES_MAX_ROWS,
    )
  })

  it('matches selection text for history rows, graphemes, and soft wraps without changing selection', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 6, rows: 3 })
    const gesture = new GhosttySelectionGesture(terminal)
    try {
      terminal.write('界é👩‍💻abcdef\r\nlast')
      gesture.selectLines(0, terminal.lineCount() - 1)
      const before = gesture.coordinates()
      const native = terminal.getSelection()
      const lines = terminal.readLines(0, terminal.lineCount())
      const text = lines
        .map((line, index) => line.text + (line.wrapped || index === lines.length - 1 ? '' : '\n'))
        .join('')
      expect(text).toBe(native)
      expect(gesture.getSelection()).toBe(native)
      expect(gesture.coordinates()).toEqual(before)
    } finally {
      gesture.dispose()
    }
  })

  it('rejects reads after disposal', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    terminal.dispose()
    expect(() => terminal.lineCount()).toThrow('disposed')
    expect(() => terminal.readLines(0, 0)).toThrow('disposed')
  })
})
