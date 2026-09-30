import { afterEach, describe, expect, it } from 'vitest'
import { PointTag } from '../abi.js'
import { assertGhosttyResult } from '../error.js'
import { requireLayout } from '../memory.js'
import { GhosttyRuntime } from '../runtime.js'
import { GhosttySelectionGesture } from '../selection.js'
import type { GhosttyTerminal } from '../terminal.js'

let runtime: GhosttyRuntime | undefined
let gesture: GhosttySelectionGesture | undefined

afterEach(() => {
  gesture?.dispose()
  gesture = undefined
  runtime?.dispose()
  runtime = undefined
})

function historyPageNodes(terminal: GhosttyTerminal): readonly number[] {
  const { memory, exports, layouts } = terminal.runtime
  const pointLayout = requireLayout(layouts, 'GhosttyPoint')
  const valueLayout = requireLayout(layouts, 'GhosttyPointValue')
  const coordinateLayout = requireLayout(layouts, 'GhosttyPointCoordinate')
  const refLayout = requireLayout(layouts, 'GhosttyGridRef')
  const point = memory.allocate(pointLayout.size)
  const ref = memory.allocate(refLayout.size)
  try {
    const coordinate =
      point + pointLayout.fields.value!.offset + valueLayout.fields.coordinate!.offset
    memory.view.setInt32(point + pointLayout.fields.tag!.offset, PointTag.Screen, true)
    memory.view.setUint16(coordinate + coordinateLayout.fields.x!.offset, 0, true)
    memory.view.setUint32(ref + refLayout.fields.size!.offset, refLayout.size, true)
    const nodes: number[] = []
    for (let row = 0; row < terminal.lineCount(); row += 1) {
      memory.view.setUint32(coordinate + coordinateLayout.fields.y!.offset, row, true)
      assertGhosttyResult(
        'page boundary fixture',
        exports.ghostty_terminal_grid_ref(terminal.handle, point, ref),
      )
      nodes.push(memory.view.getUint32(ref + refLayout.fields.node!.offset, true))
    }
    return nodes
  } finally {
    memory.free(ref, refLayout.size)
    memory.free(point, pointLayout.size)
  }
}

const fixtures = [
  {
    name: 'empty row',
    columns: 8,
    text: '',
    start: { x: 0, y: 0 },
    end: { x: 7, y: 0 },
  },
  {
    name: 'explicit blank selection',
    columns: 8,
    text: '   ',
    start: { x: 0, y: 0 },
    end: { x: 7, y: 0 },
  },
  {
    name: 'partial columns',
    columns: 8,
    text: 'abcdefgh\r\nijklmnop',
    start: { x: 2, y: 0 },
    end: { x: 3, y: 1 },
  },
  {
    name: 'empty interior and trailing rows',
    columns: 8,
    text: 'one\r\n\r\nthree\r\n\r\n',
    start: { x: 0, y: 0 },
    end: { x: 7, y: 4 },
  },
  {
    name: 'explicit spaces and empty cells',
    columns: 8,
    text: ' a  \r\n b  ',
    start: { x: 0, y: 0 },
    end: { x: 7, y: 2 },
  },
  {
    name: 'soft wraps',
    columns: 5,
    text: 'abcdefghijk',
    start: { x: 1, y: 0 },
    end: { x: 3, y: 2 },
  },
  {
    name: 'spaces across wraps',
    columns: 5,
    text: 'ab   cd  ef',
    start: { x: 0, y: 0 },
    end: { x: 4, y: 2 },
  },
  {
    name: 'wide combining and ZWJ',
    columns: 20,
    text: '界é👩‍💻',
    start: { x: 0, y: 0 },
    end: { x: 19, y: 0 },
  },
  {
    name: 'start on wide tail',
    columns: 8,
    text: '界xy',
    start: { x: 1, y: 0 },
    end: { x: 3, y: 0 },
  },
  {
    name: 'end on wide wrap spacer',
    columns: 4,
    text: 'abc界z',
    start: { x: 0, y: 0 },
    end: { x: 3, y: 0 },
  },
  {
    name: 'start on wide wrap spacer',
    columns: 4,
    text: 'abc界z',
    start: { x: 3, y: 0 },
    end: { x: 2, y: 1 },
  },
  {
    name: 'trailing explicit blank row',
    columns: 8,
    text: 'x\r\n  ',
    start: { x: 0, y: 0 },
    end: { x: 7, y: 3 },
  },
  {
    name: 'empty wrapped row',
    columns: 4,
    text: 'x       z',
    start: { x: 0, y: 0 },
    end: { x: 3, y: 2 },
  },
  {
    name: 'space with combining mark',
    columns: 8,
    text: 'x ́\r\ny',
    start: { x: 0, y: 0 },
    end: { x: 7, y: 1 },
  },
] as const

describe('plain selection parity with pinned upstream formatter', () => {
  for (const fixture of fixtures) {
    for (const trim of [true, false]) {
      for (const unwrap of [true, false]) {
        it(`${fixture.name}, trim=${trim}, unwrap=${unwrap}`, async () => {
          runtime = await GhosttyRuntime.create()
          const terminal = runtime.createTerminal({ columns: fixture.columns, rows: 6 })
          gesture = new GhosttySelectionGesture(terminal)
          terminal.write(fixture.text)
          gesture.selectRange(fixture.start, fixture.end)
          const options = { trim, unwrap }
          expect(gesture.getSelection(options)).toBe(terminal.getSelection(options))
        })
      }
    }
  }

  it('matches wide-wrap endpoints across retained history and selections larger than the read cap', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 3 })
    gesture = new GhosttySelectionGesture(terminal)
    for (const leadingRows of [0, 1]) {
      terminal.reset()
      terminal.write('\r\n'.repeat(leadingRows) + 'abc界\r\n'.repeat(2500))
      for (let row = leadingRows; row + 1 < terminal.totalRows; row += 2) {
        gesture.selectRange({ x: 0, y: row }, { x: 3, y: row })
        expect(gesture.getSelection(), `row ${row}`).toBe(terminal.getSelection())
      }
      gesture.selectLines(0, terminal.totalRows - 1)
      expect(gesture.getSelection()).toBe(terminal.getSelection())
    }
  })

  it('matches native rectangle formatting across verified upstream page boundaries', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 80, rows: 3, cellHeight: 20, cellWidth: 10 })
    gesture = new GhosttySelectionGesture(terminal)
    terminal.write(('abcd' + ' '.repeat(76) + '\r\n').repeat(2500) + 'abcd')
    const nodes = historyPageNodes(terminal)
    expect(nodes[0]).not.toBe(nodes.at(-1))
    terminal.scrollToTop()
    gesture.press({
      position: { x: 11, y: 1 },
      viewport: { x: 1, y: 0 },
      repeatDistance: 12,
      repeatIntervalNanoseconds: 500_000_000n,
      timeNanoseconds: 1_000_000_000n,
    })
    terminal.scrollToBottom()
    gesture.drag({
      geometry: { cellWidth: 10, columns: 80, paddingLeft: 0, screenHeight: 60 },
      position: { x: 29, y: 49 },
      viewport: { x: 2, y: 2 },
      rectangle: true,
    })
    expect(gesture.coordinates()).toEqual({
      start: { x: 1, y: 0 },
      end: { x: 2, y: terminal.lineCount() - 1 },
      rectangle: true,
    })
    const expected = Array.from({ length: nodes.length }, () => 'bc').join('\n')
    const native = nodes
      .map((node, row) => (row === 0 || node !== nodes[row - 1] ? 'bc' : '\nbc'))
      .join('')
    expect(native).not.toBe(expected)
    for (const unwrap of [false, true]) {
      expect(gesture.getSelection({ unwrap })).toBe(native)
      expect(terminal.getSelection({ unwrap })).toBe(native)
    }
  })

  it('matches native wrapped wide-glyph endpoints across a verified upstream page boundary', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 80, rows: 3 })
    gesture = new GhosttySelectionGesture(terminal)
    terminal.write('a'.repeat(79) + '界' + ('a'.repeat(77) + '界').repeat(1500))
    const nodes = historyPageNodes(terminal)
    const boundary = nodes.findIndex((node, row) => row > 0 && node !== nodes[row - 1])
    expect(boundary).toBeGreaterThan(0)
    expect(nodes[boundary - 1]).not.toBe(nodes[boundary])
    const row = boundary - 1
    expect(terminal.readLines(row, row + 2)).toEqual([
      { text: '界' + 'a'.repeat(77), wrapped: true },
      { text: '界' + 'a'.repeat(77), wrapped: true },
    ])
    gesture.selectRange({ x: 0, y: row }, { x: 79, y: row })
    expect(gesture.getSelection({ unwrap: true })).toBe(terminal.getSelection({ unwrap: true }))
    expect(terminal.getSelection({ unwrap: true })).toBe('界' + 'a'.repeat(77))
    expect(gesture.getSelection({ unwrap: false })).toBe(terminal.getSelection({ unwrap: false }))
  })

  for (const { text, selected } of [
    { text: 'x ́', selected: 'x' },
    { text: ' ́y', selected: ' y' },
    { text: '  　', selected: '  　' },
  ]) {
    it(`preserves history graphemes while applying native selection trim to ${JSON.stringify(text)}`, async () => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
      gesture = new GhosttySelectionGesture(terminal)
      terminal.write(text)
      gesture.selectLines(0, 0)
      expect(terminal.readLines(0, 1)).toEqual([{ text, wrapped: false }])
      expect(gesture.getSelection()).toBe(selected)
      expect(terminal.getSelection()).toBe(selected)
    })
  }

  it('tracks selection points after scrolling, overflow, and reflow', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    gesture = new GhosttySelectionGesture(terminal)
    terminal.setScrollbackLimit(4)
    terminal.write('abcdefghijk\r\nlast')
    gesture.selectRange({ x: 1, y: 0 }, { x: 2, y: 1 })
    terminal.write('\r\nnext\r\nmore')
    expect(gesture.getSelection()).toBe(terminal.getSelection())
    terminal.resize({ columns: 5, rows: 4 })
    expect(gesture.getSelection()).toBe(terminal.getSelection())
    terminal.write('x\r\n'.repeat(10000))
    expect(terminal.totalRows).toBeLessThan(10000)
    expect(gesture.getSelection()).toBe(terminal.getSelection())
  })

  it('retains native VT and HTML formatting', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    gesture = new GhosttySelectionGesture(terminal)
    terminal.write('\u001b[31m界é\u001b[0m')
    gesture.selectLines(0, 0)
    for (const format of ['vt', 'html'] as const) {
      expect(gesture.getSelection({ format })).toBe(terminal.getSelection({ format }))
      expect(gesture.getSelection({ format })).not.toBe(gesture.getSelection())
    }
  })

  it('honors unwrap for rectangles across soft-wrapped rows', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 3, cellHeight: 20, cellWidth: 10 })
    gesture = new GhosttySelectionGesture(terminal)
    terminal.write('abcdefgh')
    gesture.press({
      position: { x: 11, y: 1 },
      viewport: { x: 1, y: 0 },
      repeatDistance: 12,
      repeatIntervalNanoseconds: 500_000_000n,
      timeNanoseconds: 1_000_000_000n,
    })
    gesture.drag({
      geometry: { cellWidth: 10, columns: 4, paddingLeft: 0, screenHeight: 60 },
      position: { x: 29, y: 29 },
      viewport: { x: 2, y: 1 },
      rectangle: true,
    })
    expect(gesture.coordinates()?.rectangle).toBe(true)
    for (const unwrap of [false, true]) {
      const options = { unwrap }
      const expected = unwrap ? 'bcfg' : 'bc\nfg'
      expect(terminal.getSelection(options)).toBe(expected)
      expect(gesture.getSelection(options)).toBe(expected)
    }
  })

  it('keeps a rectangular endpoint on its row when it ends on a wide-wrap spacer', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 3, cellHeight: 20, cellWidth: 10 })
    gesture = new GhosttySelectionGesture(terminal)
    terminal.write('abc界z')
    gesture.press({
      position: { x: 11, y: 1 },
      viewport: { x: 1, y: 0 },
      repeatDistance: 12,
      repeatIntervalNanoseconds: 500_000_000n,
      timeNanoseconds: 1_000_000_000n,
    })
    gesture.drag({
      geometry: { cellWidth: 10, columns: 4, paddingLeft: 0, screenHeight: 60 },
      position: { x: 39, y: 9 },
      viewport: { x: 3, y: 0 },
      rectangle: true,
    })
    expect(gesture.coordinates()?.rectangle).toBe(true)
    for (const unwrap of [false, true]) {
      expect(terminal.getSelection({ unwrap })).toBe('bc')
      expect(gesture.getSelection({ unwrap })).toBe('bc')
    }
  })

  it('matches rectangular whitespace and wide-cell selection', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 4, cellHeight: 20, cellWidth: 10 })
    gesture = new GhosttySelectionGesture(terminal)
    terminal.write('界ab  \r\n  界cd\r\n  xy')
    const directions = [
      { start: { x: 1, y: 0 }, end: { x: 4, y: 2 } },
      { start: { x: 4, y: 0 }, end: { x: 1, y: 2 } },
      { start: { x: 4, y: 2 }, end: { x: 1, y: 0 } },
    ]
    for (const { start, end } of directions) {
      gesture.reset()
      gesture.press({
        position: { x: start.x * 10 + 1, y: start.y * 20 + 1 },
        viewport: start,
        repeatDistance: 12,
        repeatIntervalNanoseconds: 500_000_000n,
        timeNanoseconds: 1_000_000_000n,
      })
      gesture.drag({
        geometry: { cellWidth: 10, columns: 8, paddingLeft: 0, screenHeight: 80 },
        position: { x: end.x * 10 + 9, y: end.y * 20 + 9 },
        viewport: end,
        rectangle: true,
      })
      expect(gesture.coordinates()?.rectangle).toBe(true)
      for (const options of [
        { trim: true, unwrap: true },
        { trim: true, unwrap: false },
        { trim: false, unwrap: true },
        { trim: false, unwrap: false },
      ]) {
        expect(gesture.getSelection(options)).toBe(terminal.getSelection(options))
      }
    }
  })
})
