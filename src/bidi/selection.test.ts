import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalSession } from '../term/session.js'
import { readFileSync } from 'node:fs'
import { CellPin } from './pin.js'
import { BidiSelectionGesture } from './selection.js'
import { SelectedDisplayedFrame } from './selected-frame.js'
import { GhosttyRenderState } from '../core/render-state.js'
import { GhosttyTerminal } from '../core/terminal.js'
import {
  retainDisplayedFrame,
  type DisplayedFrameSource,
} from '../render/shared/displayed-frame.js'
import type { NativeDisplayedFrame } from '../core/displayed-frame.js'
import type { RenderRow } from '../core/types.js'
import { copiedFrameRow } from '../render/shared/frame-row.js'
import { PackedCells } from '../core/packed-cells.js'

let session: TerminalSession
const press = (x: number, time = 1_000_000_000n) =>
  session.selectionPress({
    viewport: { x, y: 0 },
    position: { x: x * 10 + 5, y: 5 },
    repeatDistance: 10,
    repeatIntervalNanoseconds: 500_000_000n,
    timeNanoseconds: time,
  })
const drag = (x: number) =>
  session.selectionDrag({
    viewport: { x, y: 0 },
    position: { x: x * 10 + 5, y: 5 },
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
  vi.restoreAllMocks()
  session.dispose()
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

function nativeSource() {
  const source: unknown = Reflect.get(session, 'nativeRenderState')
  if (!(source instanceof GhosttyRenderState)) throw new Error('Expected real native render state')
  return source
}
function nativeTerminal() {
  const terminal: unknown = Reflect.get(session, 'terminal')
  if (!(terminal instanceof GhosttyTerminal)) throw new Error('Expected real native terminal')
  return terminal
}
function gesture() {
  const selection: unknown = Reflect.get(session, 'bidiSelection')
  if (!(selection instanceof BidiSelectionGesture)) throw new Error('Expected BiDi gesture')
  return selection
}
function copiedPoints() {
  const mask: unknown = Reflect.get(gesture(), 'mask')
  if (mask === undefined) return undefined
  if (!mask || typeof mask !== 'object' || !('pins' in mask) || !Array.isArray(mask.pins))
    throw new Error('Expected mask pins')
  return mask.pins.flatMap((pin: unknown) => {
    if (!(pin instanceof CellPin)) throw new Error('Expected native CellPin')
    const point = pin.point()
    return point ? [{ ...point }] : []
  })
}

/** Independent checkpoint formula, using copied coordinates, offset and raw native rows. */
function oldFormulaOracle(): readonly RenderRow[] {
  const rows = nativeSource().readRows()
  const points = copiedPoints()
  if (!points) return rows
  const selected = new Set(points.map((point) => `${point.y}:${point.x}`))
  const offset = nativeTerminal().scrollbar.offset
  return rows.map((row) => ({
    ...row,
    packed: undefined,
    cells: row.cells.map((cell) => ({
      ...cell,
      selected:
        selected.has(`${row.y + offset}:${cell.x}`) ||
        (cell.continuation && selected.has(`${row.y + offset}:${cell.x - 1}`)),
    })),
  }))
}
function fullRows(rows: readonly RenderRow[]) {
  return rows.map((row) => ({ y: row.y, cells: structuredClone(row.cells) }))
}
function selected(rows: readonly RenderRow[]) {
  return rows.flatMap((row) => {
    const columns = row.cells.filter((cell) => cell.selected).map((cell) => cell.x)
    return columns.length ? [{ y: row.y, columns }] : []
  })
}
function visualDrag(start: number, end: number, y = 0) {
  session.selectionPress({
    viewport: { x: start, y },
    position: { x: start * 10 + 5, y: y * 20 + 5 },
    repeatDistance: 10,
    repeatIntervalNanoseconds: 500_000_000n,
    timeNanoseconds: 1_000_000_000n,
  })
  session.selectionDrag({
    viewport: { x: end, y },
    position: { x: end * 10 + 5, y: y * 20 + 5 },
    geometry: {
      columns: session.grid.columns,
      cellWidth: 10,
      paddingLeft: 0,
      screenHeight: session.grid.rows * 20,
    },
  })
  session.selectionRelease({ x: end, y })
}
function retained(): NativeDisplayedFrame {
  const source = session.renderState
  const retain = (source as DisplayedFrameSource)[retainDisplayedFrame]
  if (!retain) throw new Error('Missing retained source capability')
  return retain.call(source, { full: true })
}
function prepare() {
  session.renderState.update()
  const oracle = fullRows(oldFormulaOracle())
  const frame = retained()
  return { oracle, frame }
}
async function smallSession() {
  session.dispose()
  session = await TerminalSession.create({
    bidi: true,
    appearance: { grid: { columns: 20, rows: 4 } },
  })
}

it.each([
  [3, 1],
  [1, 8],
  [8, 1],
  [3, 6],
])('captures the independent visual overlay for drag %i to %i', (start, end) => {
  visualDrag(start!, end!)
  const { frame, oracle } = prepare()
  expect(session.renderState).toBe(session.renderState)
  if (start === 3 && end === 1) {
    expect(selected(nativeSource().readRows())).toEqual([{ y: 0, columns: [1, 2, 3, 4, 5, 6] }])
    expect(selected(frame.readRows())).toEqual([{ y: 0, columns: [1, 2, 6] }])
  }
  frame.accept()
  expect(fullRows(frame.readRows())).toStrictEqual(oracle)
  expect(frame).toBeInstanceOf(SelectedDisplayedFrame)
})

it('keeps the held token independent through clear, drag, range and select-all mutations', () => {
  visualDrag(3, 1)
  const { frame: a, oracle } = prepare()
  a.accept()
  session.renderState.acknowledge()
  const operations = [
    () => session.clearSelection(),
    () => visualDrag(1, 8),
    () => session.selectRange({ x: 3, y: 0 }, { x: 6, y: 0 }),
    () => session.selectAll(),
  ]
  for (const mutate of operations) {
    mutate()
    expect(fullRows(a.readRows())).toStrictEqual(oracle)
  }
  const { frame: b, oracle: next } = prepare()
  expect(fullRows(a.readRows())).toStrictEqual(oracle)
  expect(fullRows(b.readRows())).toStrictEqual(next)
  b.accept()
  expect(() => a.readRows()).toThrow(expect.objectContaining({ operation: 'read_displayed_frame' }))
  expect(b.readPreviousTextRows()[0]!.text).toContain('ab שלום cd')
})

it('does not borrow pins on any wrapped-frame read and respects native disposal first', () => {
  visualDrag(3, 1)
  const { frame } = prepare()
  frame.accept()
  const point = vi.spyOn(CellPin.prototype, 'point')
  frame.readRows()
  frame.readTextRows()
  frame.readTextRevisions()
  expect(point).not.toHaveBeenCalled()
  session.dispose()
  point.mockClear()
  expect(() => frame.readRows()).toThrow(
    expect.objectContaining({ operation: 'read_displayed_frame' }),
  )
  expect(() => frame.readTextRows()).toThrow(
    expect.objectContaining({ operation: 'read_displayed_frame' }),
  )
  expect(() => frame.readTextRevisions()).toThrow(
    expect.objectContaining({ operation: 'read_displayed_frame' }),
  )
  expect(point).not.toHaveBeenCalled()
})

it('captures literal moved-row positions at nonzero scroll offsets without moving older frames', async () => {
  await smallSession()
  session.write('\x1b[?25l\x1b[3;1Hab שלום cd')
  visualDrag(3, 1, 2)
  const { frame: a } = prepare()
  a.accept()
  session.renderState.acknowledge()
  expect(selected(a.readRows())).toEqual([{ y: 2, columns: [1, 2, 6] }])
  session.write('\r\n\r\n')
  const { frame: b, oracle } = prepare()
  expect(nativeTerminal().scrollbar.offset).toBe(1)
  expect(selected(b.readRows())).toEqual([{ y: 1, columns: [1, 2, 6] }])
  expect(selected(a.readRows())).toEqual([{ y: 2, columns: [1, 2, 6] }])
  expect(fullRows(b.readRows())).toStrictEqual(oracle)
  b.accept()
  session.renderState.acknowledge()
  session.scrollBy(-1)
  const { frame: c, oracle: history } = prepare()
  expect(nativeTerminal().scrollbar.offset).toBe(0)
  expect(selected(c.readRows())).toEqual([{ y: 2, columns: [1, 2, 6] }])
  expect(fullRows(c.readRows())).toStrictEqual(history)
  c.accept()
})

it('applies an empty held overlay to stale native selection bits instead of skipping it', async () => {
  await smallSession()
  session.write('\x1b[?25l\x1b[3;1Hab שלום cd')
  visualDrag(3, 1, 2)
  session.renderState.update()
  expect(selected(oldFormulaOracle())).toEqual([{ y: 2, columns: [1, 2, 6] }])
  const version = session.renderState.snapshotVersion
  session.renderState.acknowledge()
  session.write('\x1b[?2026h' + '\r\n'.repeat(5))
  session.renderState.update()
  expect(session.renderState.renderHeld).toBe(true)
  expect(session.renderState.snapshotVersion).toBe(version)
  expect(nativeTerminal().scrollbar.offset).toBe(4)
  expect(copiedPoints()?.map((point) => point.y)).toEqual([2, 2, 2])
  expect(copiedPoints()?.every((point) => point.y - nativeTerminal().scrollbar.offset < 0)).toBe(
    true,
  )
  expect(selected(nativeSource().readRows())).toEqual([{ y: 2, columns: [1, 2, 3, 4, 5, 6] }])
  const { frame, oracle } = prepare()
  expect(selected(frame.readRows())).toEqual([])
  expect(fullRows(frame.readRows())).toStrictEqual(oracle)
  expect(frame).toBeInstanceOf(SelectedDisplayedFrame)
  frame.accept()
})

it('retains hidden-below pins without claiming a visible-cell memory bound', async () => {
  await smallSession()
  session.write('\r\n'.repeat(10) + 'ab שלום cd')
  visualDrag(3, 1, 3)
  session.scrollToTop()
  session.renderState.update()
  expect(copiedPoints()?.map((point) => point.y)).toEqual([10, 10, 10])
  expect(nativeTerminal().scrollbar.offset).toBe(0)
  const { frame, oracle } = prepare()
  expect(frame).toBeInstanceOf(SelectedDisplayedFrame)
  expect(gesture().captureOverlay()?.get(10)?.size).toBe(3)
  expect(selected(frame.readRows())).toEqual([])
  expect(fullRows(frame.readRows())).toStrictEqual(oracle)
  frame.accept()
})

it('propagates an explicit wide lead to its continuation and the copied full snapshot', () => {
  session.write(
    '\r\x1b[2K' +
      readFileSync(
        new URL('../../bench/fixtures/correctness/bidi-wide-emoji.vt', import.meta.url),
        'utf8',
      ),
  )
  visualDrag(2, 3)
  const { frame, oracle } = prepare()
  frame.accept()
  expect(copiedPoints()?.map((point) => point.x)).toEqual([2])
  expect(selected(frame.readRows())).toEqual([{ y: 0, columns: [2, 3] }])
  expect(frame.readRows()[0]!.cells[2]!.continuation).toBe(false)
  expect(frame.readRows()[0]!.cells[3]!.continuation).toBe(true)
  expect(fullRows(frame.readRows())).toStrictEqual(oracle)
  const row = copiedFrameRow(frame.readRows()[0]!)
  expect(row.renderCells[2]!.selected).toBe(true)
  expect(row.renderCells[3]!.selected).toBe(true)
  expect(row).toStrictEqual(copiedFrameRow(oldFormulaOracle()[0]!))
})

it('honors packed and subset reads while keeping unselected captures lazy and unwrapped', () => {
  const source = session.renderState
  source.update()
  const raw = vi.spyOn(nativeSource(), 'readRows')
  const materialize = vi.spyOn(PackedCells.prototype, 'materialize')
  const plain = retained()
  expect(plain).not.toBeInstanceOf(SelectedDisplayedFrame)
  plain.readTextRows()
  plain.readTextRevisions()
  expect(raw).not.toHaveBeenCalled()
  expect(materialize).not.toHaveBeenCalled()
  expect(plain.readRows({ packed: true })[0]!.packed).toBeDefined()
  plain.accept()
  source.acknowledge()
  visualDrag(3, 1)
  const { frame, oracle } = prepare()
  const rows = frame.readRows({ packed: true, rows: new Set([0]) })
  expect(rows.map((row) => row.y)).toEqual([0])
  expect(rows[0]!.packed).toBeUndefined()
  expect(fullRows(rows)).toStrictEqual(oracle.slice(0, 1))
  expect(copiedFrameRow(rows[0]!).text).toBe(copiedFrameRow(oldFormulaOracle()[0]!).text)
  frame.accept()
})

it('clears orphaned visual pins before using the no-mask fast path', () => {
  visualDrag(3, 1)
  expect(copiedPoints()).toHaveLength(3)
  nativeTerminal().clearSelection()
  session.renderState.update()
  const frame = retained()
  expect(copiedPoints()).toBeUndefined()
  expect(frame).not.toBeInstanceOf(SelectedDisplayedFrame)
  frame.discard()
})

it('owns discarded-retry overlays and survives reflow with the independent oracle', () => {
  visualDrag(3, 1)
  const abandoned = prepare().frame
  abandoned.discard()
  visualDrag(1, 8)
  const { frame, oracle } = prepare()
  expect(() => abandoned.readRows()).toThrow(
    expect.objectContaining({ operation: 'read_displayed_frame' }),
  )
  expect(selected(frame.readRows())).toEqual([{ y: 0, columns: [1, 2, 3, 4, 5, 6, 7, 8] }])
  expect(fullRows(frame.readRows())).toStrictEqual(oracle)
  expect(frame.readTextRows()[0]!.text).toBe(copiedFrameRow(oldFormulaOracle()[0]!).text)
  frame.accept()
  session.renderState.acknowledge()
  session.write('\r\x1b[2Kab שלום 123 cd')
  session.resize({ columns: 10, rows: 8 })
  visualDrag(6, 9)
  expect(session.getSelection()).toBe('שלום')
  const next = prepare()
  expect(fullRows(next.frame.readRows())).toStrictEqual(next.oracle)
  next.frame.accept()
})

it('captures the mask before retaining, so a pin failure leaves no pending capture', () => {
  visualDrag(3, 1)
  session.renderState.update()
  const point = vi.spyOn(CellPin.prototype, 'point').mockImplementationOnce(() => {
    throw new Error('injected capture pin failure')
  })
  expect(() => retained()).toThrow('injected capture pin failure')
  point.mockRestore()
  const { frame, oracle } = prepare()
  expect(fullRows(frame.readRows())).toStrictEqual(oracle)
  frame.accept()
})
