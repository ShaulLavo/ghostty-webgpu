import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TerminalSession } from '../term/session.js'

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
afterEach(() => session.dispose())
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
})
