import { afterEach, expect, it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

it.each([
  { name: 'woman technologist', text: '👩‍💻', on: 2, off: 4 },
  { name: 'CJK', text: '你好', on: 4, off: 4 },
  { name: 'combining accent', text: 'é', on: 1, off: 1 },
  { name: 'heart variation selector', text: '❤️', on: 2, off: 1 },
])('preserves mode2027 native $name widths and frame cell ownership', async ({ text, on, off }) => {
  runtime = await GhosttyRuntime.create()
  for (const [mode, width] of [
    [true, on],
    [false, off],
  ] as const) {
    const terminal = runtime.createTerminal({ columns: 24, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write(mode ? '\x1b[?2027h' : '\x1b[?2027l')
    for (const scalar of text) terminal.write(scalar)
    state.update()
    expect(terminal.cursor.x).toBe(width)
    const cells = state.readRows()[0]!.cells
    expect(
      cells
        .slice(0, width)
        .filter((cell) => cell.text)
        .map((cell) => cell.text)
        .join(''),
    ).toBe(text)
    expect(cells[width]!.text).toBe('')
    state.acknowledge()
    terminal.write('\x1b[2;1Hx')
    state.update()
    expect(state.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual([0, 1])
    expect(terminal.cursor).toMatchObject({ x: 1, y: 1 })
  }
})
