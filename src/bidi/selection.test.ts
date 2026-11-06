import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GhosttySelectionGesture } from '../core/selection.js'
import { capturedRowsReader, selectedRowsFrom } from './selection.js'
import { CellPin } from './pin.js'
import { TerminalSession } from '../term/session.js'

let session: TerminalSession
const press = (x: number, time = 1_000_000_000n, y = 0) =>
  session.selectionPress({
    viewport: { x, y },
    position: { x: x * 10 + 5, y: y * 20 + 5 },
    repeatDistance: 10,
    repeatIntervalNanoseconds: 500_000_000n,
    timeNanoseconds: time,
  })
const drag = (x: number, y = 0) =>
  session.selectionDrag({
    viewport: { x, y },
    position: { x: x * 10 + 5, y: y * 20 + 5 },
    geometry: { columns: 40, cellWidth: 10, paddingLeft: 0, screenHeight: 160 },
  })

beforeEach(async () => {
  session = await TerminalSession.create({
    bidi: true,
    appearance: { grid: { columns: 40, rows: 8 } },
  })
  session.write('\x1b[?25lab שלום cd')
})
afterEach(() => {
  session.dispose()
  vi.restoreAllMocks()
})
function expectCopiedStyle(vt: string, plain: string | undefined): void {
  const roundTrip = session.runtime.createTerminal({ columns: 40, rows: 8 })
  try {
    roundTrip.write(vt)
    expect(roundTrip.readLines(0, 1)[0]!.text).toBe(plain)
    const state = session.runtime.createRenderState(roundTrip)
    try {
      state.update()
      expect(state.readRows()[0]!.cells[0]!.foreground).toEqual(session.appearance.theme.palette[1])
    } finally {
      state.dispose()
    }
  } finally {
    roundTrip.dispose()
  }
}

describe('BiDi native selection', () => {
  it.each([
    [1, 8, 'b שלום c'],
    [8, 1, 'b שלום c'],
    [3, 6, 'שלום'],
    [3, 1, 'b ם'],
  ])('copies a visual drag %i to %i logically', (start, end, text) => {
    press(start)
    drag(end)
    session.selectionRelease({ x: end, y: 0 })
    expect(session.getSelection()).toBe(text)
    const selected = session.renderState
      .readRows()[0]!
      .cells.filter((cell) => cell.selected)
      .map((cell) => cell.x)
    expect(selected).toEqual(text === 'b ם' ? [1, 2, 6] : expect.any(Array))
  })
  it('keeps logical word finding for noncontiguous visual highlights', () => {
    session.write('\r\x1b[2Kא:אa')
    press(3)
    session.selectionRelease({ x: 3, y: 0 })
    press(3, 1_100_000_000n)
    expect(session.getSelection()).toBe('אa')
    session.renderState.update()
    expect(
      session.renderState
        .readRows()[0]!
        .cells.filter((cell) => cell.selected)
        .map((cell) => cell.x),
    ).toEqual([2, 3])
  })
  it('retains selected cells across reflow', () => {
    session.write('\r\x1b[2Kab שלום 123 cd')
    session.resize({ columns: 10, rows: 8 })
    press(6)
    drag(9)
    session.selectionRelease({ x: 9, y: 0 })
    expect(session.getSelection()).toBe('שלום')
    session.resize({ columns: 14, rows: 8 })
    expect(session.getSelection()).toBe('שלום')
    session.resize({ columns: 8, rows: 8 })
    expect(session.getSelection()).toBe('שלום')
  })
  it('keeps hard line breaks and trims empty padding on visual drags', () => {
    session.write('\r\nsecond')
    press(6)
    session.selectionDrag({
      viewport: { x: 2, y: 1 },
      position: { x: 25, y: 25 },
      geometry: { columns: 40, cellWidth: 10, paddingLeft: 0, screenHeight: 160 },
    })
    session.selectionRelease({ x: 2, y: 1 })
    expect(session.getSelection()).toBe('ש cd\nsec')
  })
  it('clears visual masks before a programmatic selection', () => {
    press(3)
    drag(1)
    session.selectionRelease({ x: 1, y: 0 })
    expect(session.getSelection()).toBe('b ם')
    session.clearSelection()
    expect(session.getSelection()).toBeUndefined()
    session.selectRange({ x: 3, y: 0 }, { x: 6, y: 0 })
    expect(session.getSelection()).toBe('שלום')
  })
  it('formats a disjoint selection as one HTML and VT document', () => {
    session.write('\r\x1b[2K\x1b[31mb\x1b[0m<א&ב')
    press(4)
    drag(0)
    session.selectionRelease({ x: 0, y: 0 })
    const plain = session.getSelection()
    const html = session.getSelection({ format: 'html' })!
    const vt = session.getSelection({ format: 'vt' })!
    expect((html.match(/<style>/g) ?? []).length).toBe(1)
    expect((html.match(/<div style="font-family:/g) ?? []).length).toBe(1)
    expect(html).toContain('color: var(--vt-palette-1)')
    expect(html).toContain('&lt;')
    expect(html).toContain('&amp;')
    expect((vt.match(/\x1b\]4;0;/g) ?? []).length).toBe(1)
    expectCopiedStyle(vt, plain)
  })
  it('uses one format envelope for a selection with logical holes', () => {
    press(3)
    drag(1)
    session.selectionRelease({ x: 1, y: 0 })
    expect(session.getSelection()).toBe('b ם')
    expect((session.getSelection({ format: 'html' })!.match(/<div/g) ?? []).length).toBe(1)
    expect((session.getSelection({ format: 'vt' })!.match(/\x1b\]4;0;/g) ?? []).length).toBe(1)
  })
  it('reports the native rectangle shape for rectangular visual drags', async () => {
    session.dispose()
    session = await TerminalSession.create({
      bidi: true,
      appearance: { grid: { columns: 4, rows: 8 } },
    })
    session.write('abcdefgh')
    press(1)
    session.selectionDrag({
      viewport: { x: 2, y: 1 },
      position: { x: 25, y: 25 },
      geometry: { columns: 4, cellWidth: 10, paddingLeft: 0, screenHeight: 160 },
      rectangle: true,
    })
    session.selectionRelease({ x: 2, y: 1 })
    expect(session.selectionCoordinates()?.rectangle).toBe(true)
    expect(session.getSelection()).toBe('bc\nfg')
    expect((session.getSelection({ format: 'html' })!.match(/<style>/g) ?? []).length).toBe(1)
    const vt = session.getSelection({ format: 'vt' })!
    expect((vt.match(/\x1b\]4;0;/g) ?? []).length).toBe(1)
    const copy = session.runtime.createTerminal({ columns: 4, rows: 8 })
    try {
      copy.write(vt)
      expect(copy.readLines(0, 2).map((line) => line.text)).toEqual(['bc', 'fg'])
    } finally {
      copy.dispose()
    }
  })
})

it('keeps the visual selection on the frozen row when held output scrolls the live screen', () => {
  session.resize({ columns: 20, rows: 4 })
  session.write('\x1b[2J\x1b[3;1Hab שלום cd')
  press(3, 1_000_000_000n, 2)
  drag(1, 2)
  session.selectionRelease({ x: 1, y: 2 })
  const state = session.renderState
  state.update()
  const selected = () =>
    state.readRows().flatMap((row) => {
      const columns = row.cells.filter((cell) => cell.selected).map((cell) => cell.x)
      return columns.length ? [{ y: row.y, columns }] : []
    })
  expect(selected()).toEqual([{ y: 2, columns: [1, 2, 6] }])
  expect(session.getSelection()).toBe('b ם')
  state.acknowledge()
  session.write('\x1b[?2026h')
  const version = state.snapshotVersion
  session.write('\r\n'.repeat(5))
  state.update()
  expect(state.renderHeld).toBe(true)
  expect(state.snapshotVersion).toBe(version)
  expect(session.scrollbar.offset).toBe(4)
  expect(selected()).toEqual([{ y: 2, columns: [1, 2, 6] }])
  expect(session.getSelection()).toBe('b ם')
  session.write('\x1b[?2026l')
  state.update()
  expect(state.snapshotVersion).not.toBe(version)
  expect(selected()).toEqual([])
  session.scrollToTop()
  state.update()
  expect(selected()).toEqual([{ y: 2, columns: [1, 2, 6] }])
})

function selectedRows() {
  return session.renderState.readRows().flatMap((row) => {
    const columns = row.cells.filter((cell) => cell.selected).map((cell) => cell.x)
    return columns.length ? [{ y: row.y, columns }] : []
  })
}

function visualSelection(start = 3, end = 1, y = 0): void {
  press(start, 1_000_000_000n, y)
  drag(end, y)
  session.selectionRelease({ x: end, y })
  session.renderState.update()
  session.renderState.acknowledge()
}

it('retires an empty hold when the visual selection is replaced by its native bounds', () => {
  visualSelection()
  const state = session.renderState
  const version = state.snapshotVersion
  session.write('\x1b[?2026h\x1b[?2026l')
  state.update()
  state.acknowledge()
  expect(state.snapshotVersion).toBe(version)
  expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2, 6] }])
  session.selectRange({ x: 1, y: 0 }, { x: 6, y: 0 })
  state.update()
  expect(state.snapshotVersion).not.toBe(version)
  expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2, 3, 4, 5, 6] }])
})

it('does not borrow live pins for a held row or a released snapshot awaiting update', () => {
  visualSelection()
  session.write('\x1b[?2026h')
  const pinRead = vi.spyOn(CellPin.prototype, 'point')
  expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2, 6] }])
  expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2, 6] }])
  expect(pinRead).not.toHaveBeenCalled()
  session.write('\r\n'.repeat(10) + '\x1b[?2026l')
  pinRead.mockClear()
  expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2, 6] }])
  expect(pinRead).not.toHaveBeenCalled()
  session.renderState.update()
  expect(selectedRows()).toEqual([])
})

it.each(['clear', 'range', 'bounds', 'drag'] as const)(
  'keeps held paint while a user changes the live selection with %s',
  (change) => {
    visualSelection()
    session.write('\x1b[?2026h')
    if (change === 'clear') session.clearSelection()
    if (change === 'range') session.selectRange({ x: 3, y: 0 }, { x: 6, y: 0 })
    if (change === 'bounds') session.selectRange({ x: 1, y: 0 }, { x: 6, y: 0 })
    if (change === 'drag') visualSelection(7, 8)
    const expectedText = { clear: undefined, range: 'שלום', bounds: 'b שלום', drag: ' c' }[change]
    expect(session.getSelection()).toBe(expectedText)
    session.renderState.update()
    expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2, 6] }])
    session.write('\x1b[?2026l')
    expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2, 6] }])
    session.renderState.update()
    const columns = { clear: [], range: [3, 4, 5, 6], bounds: [1, 2, 3, 4, 5, 6], drag: [7, 8] }[
      change
    ]
    expect(selectedRows()).toEqual(columns.length ? [{ y: 0, columns }] : [])
  },
)

it('keeps an unselected hold unselected when a new visual selection is made', () => {
  session.renderState.update()
  session.renderState.acknowledge()
  session.write('\x1b[?2026h')
  visualSelection()
  expect(session.getSelection()).toBe('b ם')
  expect(selectedRows()).toEqual([])
  session.write('\x1b[?2026l')
  session.renderState.update()
  expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2, 6] }])
})

it('captures a nonzero viewport offset before held scrolling', () => {
  session.resize({ columns: 20, rows: 4 })
  session.write('\x1b[2J\x1b[3;1Hab שלום cd')
  visualSelection(3, 1, 2)
  session.write('\r\n'.repeat(5))
  session.scrollToRow(1)
  session.renderState.update()
  expect(session.scrollbar.offset).toBe(1)
  expect(selectedRows()).toEqual([{ y: 1, columns: [1, 2, 6] }])
  session.write('\x1b[?2026h')
  session.scrollToBottom()
  session.renderState.update()
  expect(session.scrollbar.offset).toBe(4)
  expect(selectedRows()).toEqual([{ y: 1, columns: [1, 2, 6] }])
  session.write('\x1b[?2026l')
  session.renderState.update()
  expect(selectedRows()).toEqual([])
})

it('preserves wide lead and tail selection through a hold and clears on release', () => {
  session.write('\r\x1b[2Ka界b שלום cd')
  visualSelection(1, 2)
  expect(session.getSelection()).toBe('界')
  expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2] }])
  session.write('\x1b[?2026h')
  session.clearSelection()
  expect(selectedRows()).toEqual([{ y: 0, columns: [1, 2] }])
  session.write('\x1b[?2026l')
  session.renderState.update()
  expect(selectedRows()).toEqual([])
})

it('uses reflowed pins when resize releases held output', () => {
  session.write('\r\x1b[2Kab שלום 123 cd')
  session.resize({ columns: 10, rows: 8 })
  visualSelection(6, 9)
  expect(selectedRows()).toEqual([{ y: 0, columns: [3, 4, 5, 6] }])
  session.write('\x1b[?2026h')
  session.resize({ columns: 14, rows: 8 })
  session.renderState.update()
  expect(session.renderState.renderHeld).toBe(false)
  expect(session.getSelection()).toBe('שלום')
  expect(selectedRows()).toEqual([{ y: 0, columns: [3, 4, 5, 6] }])
})

it('captures each hold even without a draw or a previous overlay read', () => {
  visualSelection()
  session.write('\x1b[?2026h')
  session.clearSelection()
  session.write('\x1b[?2026l\x1b[?2026h')
  expect(selectedRows()).toEqual([])
  session.write('\x1b[?2026l')
  visualSelection(3, 6)
  session.write('\x1b[?2026h')
  expect(selectedRows()).toEqual([{ y: 0, columns: [3, 4, 5, 6] }])
})

it('retires held selection reads on disposal', () => {
  visualSelection()
  session.write('\x1b[?2026h')
  const state = session.renderState
  session.dispose()
  expect(() => state.readRows()).toThrow('disposed')
})

it('leaves held programmatic selection and unselected output to the native snapshot', () => {
  session.selectRange({ x: 3, y: 0 }, { x: 6, y: 0 })
  session.renderState.update()
  expect(selectedRows()).toEqual([{ y: 0, columns: [3, 4, 5, 6] }])
  session.write('\x1b[?2026h' + '\r\n'.repeat(10))
  session.renderState.update()
  expect(selectedRows()).toEqual([{ y: 0, columns: [3, 4, 5, 6] }])
  session.write('\x1b[?2026l')
  session.renderState.update()
  expect(selectedRows()).toEqual([])
  session.clearSelection()
  session.write('\x1b[?2026h' + '\r\n'.repeat(10))
  session.renderState.update()
  expect(selectedRows()).toEqual([])
  session.write('\x1b[?2026l')
  session.renderState.update()
  expect(selectedRows()).toEqual([])
})

it('captures empty-present membership through the gesture reader decision over real selected rows', () => {
  const vt = session.runtime.createTerminal({ columns: 20, rows: 4 })
  const state = session.runtime.createRenderState(vt)
  const selection = new GhosttySelectionGesture(vt)
  try {
    vt.write('abcdef')
    selection.selectRange({ x: 0, y: 0 }, { x: 5, y: 0 })
    state.update()
    const rows = state.readRows({ packed: true })
    expect(rows[0]!.cells.filter((cell) => cell.selected).map((cell) => cell.x)).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
    const nativeRows = Object.freeze({ readRows: state.readRows.bind(state) })
    const absent = capturedRowsReader(state, undefined, nativeRows)
    expect(absent).toBe(nativeRows)
    expect(absent.readRows({ packed: true })[0]!.packed).toBeDefined()
    const captured = capturedRowsReader(state, new Set(), nativeRows)
    expect(captured).not.toBe(nativeRows)
    const empty = captured.readRows({ packed: true })
    expect(empty.every((row) => row.cells.every((cell) => !cell.selected))).toBe(true)
    expect(empty[0]!.packed).toBeUndefined()
    expect(selectedRowsFrom(rows, new Set())[0]!.cells.every((cell) => !cell.selected)).toBe(true)
  } finally {
    selection.dispose()
    state.dispose()
    vt.dispose()
  }
})

it('decorates a real wide tail from only its lead membership key', () => {
  session.write('\r\x1b[2Ka界b שלום cd')
  session.renderState.update()
  const rows = session.renderState.readRows({ packed: true })
  expect(rows[0]!.cells[2]!.continuation).toBe(true)
  expect(
    selectedRowsFrom(rows, new Set(['0:1']))[0]!
      .cells.filter((cell) => cell.selected)
      .map((cell) => cell.x),
  ).toEqual([1, 2])
})
