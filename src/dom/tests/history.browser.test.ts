import { afterEach, describe, expect, it } from 'vitest'
import { Terminal, TERMINAL_READ_LINES_MAX_ROWS } from '../../../dist/index.js'

const terminals: Terminal[] = []
const hosts: HTMLDivElement[] = []

async function openTerminal(): Promise<Terminal> {
  const terminal = await Terminal.create({ appearance: { grid: { columns: 8, rows: 3 } } })
  terminals.push(terminal)
  const host = document.createElement('div')
  host.style.width = '420px'
  host.style.height = '140px'
  document.body.append(host)
  hosts.push(host)
  await terminal.open(host)
  terminal.setAppearance({ grid: { columns: 8, rows: 3 } })
  return terminal
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose()
  for (const host of hosts.splice(0)) host.remove()
})

describe('built native history API in Chromium', () => {
  it('reads empty rows before opening with the same lifecycle guard as visibleLines', async () => {
    const terminal = await Terminal.create({ appearance: { grid: { columns: 8, rows: 3 } } })
    terminals.push(terminal)
    expect(terminal.visibleLines()).toEqual([])
    expect(terminal.lineCount()).toBe(3)
    expect(terminal.readLines(0, 1)).toEqual([{ text: '', wrapped: false }])
  })

  it('reads history before paint and preserves selection and visibleLines', async () => {
    const terminal = await openTerminal()
    terminal.write('one\r\ntwo\r\nthree\r\nfour')
    terminal.selectLines(0, 1)
    const selection = terminal.selectionCoordinates()
    const text = terminal.getSelection()
    const visible = terminal.visibleLines()
    terminal.scrollToTop()

    expect(terminal.lineCount()).toBe(4)
    expect(terminal.readLines(-1, 20)).toEqual([
      { text: 'one', wrapped: false },
      { text: 'two', wrapped: false },
      { text: 'three', wrapped: false },
      { text: 'four', wrapped: false },
    ])
    expect(terminal.readLines(0, 1, { trimRight: false })).toEqual([
      { text: 'one', wrapped: false },
    ])
    expect(terminal.selectionCoordinates()).toEqual(selection)
    expect(terminal.getSelection()).toBe(text)
    expect(terminal.visibleLines()).toEqual(visible)
    terminal.scrollToBottom()
    expect(terminal.readLines(0, 1)).toEqual([{ text: 'one', wrapped: false }])
  })

  it('exports the row cap and reads the active screen through the built API', async () => {
    const terminal = await openTerminal()
    terminal.write('x\r\n'.repeat(TERMINAL_READ_LINES_MAX_ROWS + 30))
    expect(terminal.readLines(0, Infinity)).toHaveLength(TERMINAL_READ_LINES_MAX_ROWS)
    terminal.write('\u001b[?1049h\u001b[HALT')
    expect(terminal.lineCount()).toBe(3)
    expect(terminal.readLines(0, 1)).toEqual([{ text: 'ALT', wrapped: false }])
    terminal.write('\u001b[?1049l')
    expect(terminal.lineCount()).toBeGreaterThan(TERMINAL_READ_LINES_MAX_ROWS)
    terminal.dispose()
    expect(() => terminal.lineCount()).toThrow('disposed')
    expect(() => terminal.readLines(0, 1)).toThrow('disposed')
  })
})
