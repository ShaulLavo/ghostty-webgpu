import { afterEach, describe, expect, it } from 'vitest'
import { Terminal, TERMINAL_READ_LINES_MAX_ROWS } from '../../../dist/index.js'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'

const terminals: Array<Terminal | WorkerTerminal> = []
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

afterEach(async () => {
  for (const terminal of terminals.splice(0)) await terminal.dispose()
  for (const host of hosts.splice(0)) host.remove()
})

describe('built native history API in Chromium', () => {
  it.each(['main', 'worker'] as const)(
    'keeps %s history, selection and mirrors on the retained native rows',
    async (mode) => {
      const appearance = {
        grid: { columns: 40, rows: 12 },
        scrollbackByteLimit: 64 * 1024 * 1024,
        scrollbackLimit: 10000,
      }
      const terminal =
        mode === 'main'
          ? await Terminal.create({ appearance })
          : await WorkerTerminal.create({
              appearance,
              fonts: [
                {
                  family: 'HistoryTest',
                  source: {
                    url: new URL(
                      '../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2',
                      import.meta.url,
                    ).href,
                  },
                },
              ],
            })
      terminals.push(terminal)
      const host = document.createElement('div')
      host.style.cssText = 'width:480px;height:280px'
      document.body.append(host)
      hosts.push(host)
      await terminal.open(host)
      await expect.poll(() => terminal.submittedFrame).toBeDefined()
      const rows = terminal.submittedFrame!.grid.rows
      expect(await terminal.lineCount()).toBe(rows)
      expect(terminal.appearance.scrollbackByteLimit).toBe(64 * 1024 * 1024)
      const written = Array.from({ length: 20000 }, (_, index) => `row-${index}`)
      await terminal.write(written.join('\r\n'))
      const count = await terminal.lineCount()
      expect(count).toBeGreaterThan(rows)
      expect(count).toBeLessThan(10000 + rows)
      const retained = written.slice(-count)
      const lines = []
      for (let start = 0; start < count; start += TERMINAL_READ_LINES_MAX_ROWS) {
        lines.push(...(await terminal.readLines(start, count)))
      }
      expect(lines.map((line) => line.text)).toEqual(retained)
      expect(lines.some((line) => line.text === 'row-0')).toBe(false)
      await terminal.selectLines(0, 1)
      expect(await terminal.getSelection()).toBe(retained.slice(0, 2).join('\n'))
      await terminal.scrollToTop()
      await expect
        .poll(() => terminal.visibleLines().map((line) => line.trimEnd()))
        .toEqual(retained.slice(0, rows))
      const mirrorRows = () => Array.from(host.querySelectorAll('[role="listitem"]'))
      await expect
        .poll(() => mirrorRows().map((row) => row.textContent))
        .toEqual(retained.slice(0, rows))
      expect(mirrorRows().map((row) => row.getAttribute('aria-setsize'))).toEqual(
        Array(rows).fill(String(count)),
      )
      expect(terminal.submittedFrame?.scrollbar.total).toBe(count)
      await terminal.setAppearance({ scrollbackByteLimit: 0 })
      expect(await terminal.lineCount()).toBe(rows)
      expect(await terminal.getSelection()).toBe(
        (await terminal.readLines(0, 1))[0]!.text.slice(0, 1),
      )
      expect(await terminal.selectionCoordinates()).toEqual({
        end: { x: 0, y: 0 },
        rectangle: false,
        start: { x: 0, y: 0 },
      })
      await terminal.write('\r\nmore')
      expect(await terminal.lineCount()).toBe(rows)
      await terminal.scrollToTop()
      await expect.poll(() => terminal.submittedFrame?.scrollbar.total).toBe(rows)
      await expect
        .poll(() => mirrorRows().map((row) => row.getAttribute('aria-setsize')))
        .toEqual(Array(rows).fill(String(rows)))
      await terminal.setAppearance({
        scrollbackByteLimit: 0xffffffff,
        scrollbackLimit: 0xffffffff,
      })
      expect(terminal.appearance.scrollbackByteLimit).toBeUndefined()
      expect(terminal.appearance.scrollbackLimit).toBeUndefined()
      await terminal.write('\r\nunlimited')
      expect(await terminal.lineCount()).toBe(rows + 1)
    },
  )

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
