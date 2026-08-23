import { afterEach, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import {
  GhosttySelectionGesture,
  type SelectionDragEvent,
  type SelectionGestureGeometry,
  type SelectionPressEvent,
} from '../selection.js'
import type { GhosttyTerminal } from '../terminal.js'

const cellHeight = 20
const cellWidth = 10
const repeatDistance = 12
const repeatIntervalNanoseconds = 500_000_000n

let gesture: GhosttySelectionGesture | undefined
let runtime: GhosttyRuntime | undefined

afterEach(() => {
  gesture?.dispose()
  gesture = undefined
  runtime?.dispose()
  runtime = undefined
})

function geometry(columns: number, rows: number): SelectionGestureGeometry {
  return {
    cellWidth,
    columns,
    paddingLeft: 0,
    screenHeight: rows * cellHeight,
  }
}

function pressEvent(
  x: number,
  y: number,
  timeNanoseconds: bigint,
  surfaceX = x * cellWidth + cellWidth / 2,
): SelectionPressEvent {
  return {
    position: { x: surfaceX, y: y * cellHeight + cellHeight / 2 },
    repeatDistance,
    repeatIntervalNanoseconds,
    timeNanoseconds,
    viewport: { x, y },
  }
}

function dragEvent(
  columns: number,
  rows: number,
  x: number,
  y: number,
  surfaceX = x * cellWidth + cellWidth / 2,
  surfaceY = y * cellHeight + cellHeight / 2,
  rectangle = false,
): SelectionDragEvent {
  return {
    geometry: geometry(columns, rows),
    position: { x: surfaceX, y: surfaceY },
    rectangle,
    viewport: { x, y },
  }
}

async function createSelectionTerminal(columns: number, rows: number): Promise<GhosttyTerminal> {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ cellHeight, cellWidth, columns, rows })
  gesture = new GhosttySelectionGesture(terminal)
  return terminal
}

function performClick(
  activeGesture: GhosttySelectionGesture,
  x: number,
  y: number,
  timeNanoseconds: bigint,
): void {
  activeGesture.press(pressEvent(x, y, timeNanoseconds))
  activeGesture.release({ x, y })
}

describe('native selection gesture', () => {
  it('installs forward and reverse cell drags and retains selection on release', async () => {
    const terminal = await createSelectionTerminal(8, 3)
    terminal.write('abcdef')

    const press = gesture!.press(pressEvent(0, 0, 1_000_000_000n, 1))
    expect(press).toEqual({
      autoscroll: 'none',
      selectionChanged: false,
      selectionInstalled: false,
    })
    const forward = gesture!.drag(dragEvent(8, 3, 2, 0, 29))

    expect(forward).toEqual({
      autoscroll: 'none',
      selectionChanged: true,
      selectionInstalled: true,
    })
    expect(gesture!.getSelection()).toBe('abc')
    expect(gesture!.coordinates()).toEqual({
      end: { x: 2, y: 0 },
      rectangle: false,
      start: { x: 0, y: 0 },
    })

    const repeatedDrag = gesture!.drag(dragEvent(8, 3, 2, 0, 29))
    expect(repeatedDrag).toEqual({
      autoscroll: 'none',
      selectionChanged: false,
      selectionInstalled: true,
    })
    expect(gesture!.getSelection()).toBe('abc')

    const noMovementAtEdge = gesture!.drag(dragEvent(8, 3, 0, 0, 1, 60))
    expect(noMovementAtEdge).toEqual({
      autoscroll: 'down',
      selectionChanged: false,
      selectionInstalled: false,
    })
    expect(gesture!.getSelection()).toBe('abc')

    const noValueDrag = gesture!.drag(dragEvent(8, 3, 0, 0, 1))
    expect(noValueDrag).toEqual({
      autoscroll: 'none',
      selectionChanged: false,
      selectionInstalled: false,
    })
    expect(gesture!.getSelection()).toBe('abc')

    const release = gesture!.release({ x: 2, y: 0 })
    expect(release).toEqual({ autoscroll: 'none', dragged: true })
    expect(gesture!.getSelection()).toBe('abc')

    gesture!.reset()
    expect(gesture!.getSelection()).toBe('abc')
    const reversePress = gesture!.press(pressEvent(4, 0, 2_000_000_000n, 49))
    expect(reversePress.selectionChanged).toBe(true)
    expect(reversePress.selectionInstalled).toBe(false)
    expect(gesture!.getSelection()).toBeUndefined()

    gesture!.drag(dragEvent(8, 3, 2, 0, 21))
    expect(gesture!.getSelection()).toBe('cde')
    expect(gesture!.coordinates()).toEqual({
      end: { x: 4, y: 0 },
      rectangle: false,
      start: { x: 2, y: 0 },
    })
    expect(gesture!.release()).toEqual({ autoscroll: 'none', dragged: true })
    expect(gesture!.getSelection()).toBe('cde')
  })

  it('uses native double-click word and triple-click line behavior', async () => {
    const terminal = await createSelectionTerminal(20, 4)
    terminal.write('alpha beta gamma\r\nsecond row')

    performClick(gesture!, 7, 0, 1_000_000_000n)
    const word = gesture!.press(pressEvent(7, 0, 1_100_000_000n))

    expect(word.selectionInstalled).toBe(true)
    expect(gesture!.getSelection()).toBe('beta')
    expect(gesture!.release({ x: 7, y: 0 }).dragged).toBe(false)

    gesture!.reset()
    performClick(gesture!, 3, 1, 2_000_000_000n)
    performClick(gesture!, 3, 1, 2_100_000_000n)
    const line = gesture!.press(pressEvent(3, 1, 2_200_000_000n))

    expect(line.selectionInstalled).toBe(true)
    expect(gesture!.getSelection()).toBe('second row')
  })

  it('installs rectangular selections without a JavaScript range model', async () => {
    const terminal = await createSelectionTerminal(5, 3)
    terminal.write('abcde\r\nfghij\r\nklmno')

    gesture!.press(pressEvent(1, 0, 1_000_000_000n, 11))
    const update = gesture!.drag(dragEvent(5, 3, 2, 2, 29, 50, true))

    expect(update.selectionInstalled).toBe(true)
    expect(gesture!.getSelection()).toBe('bc\ngh\nlm')
    expect(gesture!.coordinates()).toEqual({
      end: { x: 2, y: 2 },
      rectangle: true,
      start: { x: 1, y: 0 },
    })
  })

  it('extends selection through history with one-row native autoscroll ticks', async () => {
    const terminal = await createSelectionTerminal(8, 3)
    terminal.write('0\r\n1\r\n2\r\n3\r\n4\r\n5')
    terminal.scrollToTop()

    gesture!.press(pressEvent(0, 0, 1_000_000_000n, 1))
    const drag = gesture!.drag(dragEvent(8, 3, 0, 2, 9, 60))

    expect(drag.autoscroll).toBe('down')
    expect(terminal.scrollbar.offset).toBe(0)
    expect(gesture!.coordinates()).toEqual({
      end: { x: 0, y: 2 },
      rectangle: false,
      start: { x: 0, y: 0 },
    })

    const tick = gesture!.autoscrollTick(dragEvent(8, 3, 0, 2, 9, 60))

    expect(tick).toEqual({
      autoscroll: 'down',
      selectionChanged: true,
      selectionInstalled: true,
    })
    expect(terminal.scrollbar.offset).toBe(1)
    expect(gesture!.coordinates()).toEqual({
      end: { x: 0, y: 3 },
      rectangle: false,
      start: { x: 0, y: 0 },
    })
    expect(gesture!.getSelection()).toBe('0\n1\n2\n3')

    const beforeRelease = gesture!.getSelection()
    expect(gesture!.release({ x: 0, y: 2 })).toEqual({
      autoscroll: 'none',
      dragged: true,
    })
    expect(gesture!.getSelection()).toBe(beforeRelease)

    expect(gesture!.clear()).toBe(true)
    expect(gesture!.selectAll()).toEqual({
      autoscroll: 'none',
      selectionChanged: true,
      selectionInstalled: true,
    })
    expect(gesture!.getSelection()).toBe('0\n1\n2\n3\n4\n5')
    expect(gesture!.coordinates()).toEqual({
      end: { x: 0, y: 5 },
      rectangle: false,
      start: { x: 0, y: 0 },
    })
    expect(gesture!.selectAll()).toEqual({
      autoscroll: 'none',
      selectionChanged: false,
      selectionInstalled: true,
    })
  })

  it('formats wide and combining graphemes and copies OSC 8 URIs', async () => {
    const terminal = await createSelectionTerminal(24, 3)
    terminal.write('\u001b]8;;https://example.com/path\u0007e\u0301界\u001b]8;;\u0007')

    expect(gesture!.selectAll()).toEqual({
      autoscroll: 'none',
      selectionChanged: true,
      selectionInstalled: true,
    })
    expect(gesture!.getSelection()).toBe('e\u0301界')
    expect(gesture!.linkAt({ x: 0, y: 0 })).toBe('https://example.com/path')
    expect(gesture!.linkAt({ x: 10, y: 0 })).toBeUndefined()
    expect(gesture!.clear()).toBe(true)
    expect(gesture!.clear()).toBe(false)
    expect(gesture!.coordinates()).toBeUndefined()
  })

  it('reacquires snapshots after writes and resize instead of caching raw refs', async () => {
    const terminal = await createSelectionTerminal(8, 3)
    terminal.write('abcdef')
    gesture!.press(pressEvent(0, 0, 1_000_000_000n, 1))
    gesture!.drag(dragEvent(8, 3, 2, 0, 29))

    const first = gesture!.coordinates()
    terminal.write('Z')
    expect(gesture!.coordinates()).toEqual(first)
    expect(gesture!.getSelection()).toBe('abc')

    terminal.resize({ columns: 4 })
    expect(gesture!.coordinates()).toEqual(first)
    expect(gesture!.getSelection()).toBe('abc')

    gesture!.reset()
    gesture!.press(pressEvent(0, 0, 2_000_000_000n, 1))
    const update = gesture!.drag(dragEvent(4, 3, 1, 0, 19))
    expect(update.selectionInstalled).toBe(true)
    expect(gesture!.getSelection()).toBe('ab')
  })

  it('tracks a live press anchor through VT writes, viewport scrolling, and reflow', async () => {
    const terminal = await createSelectionTerminal(8, 3)
    terminal.write('abcdefgh\r\nijklmnop\r\nqrstuvwx\r\nyz')
    terminal.scrollToTop()

    expect(gesture!.press(pressEvent(1, 0, 1_000_000_000n))).toEqual({
      autoscroll: 'none',
      selectionChanged: false,
      selectionInstalled: false,
    })

    terminal.write('\r\nmore')
    terminal.scrollToRow(1)
    terminal.resize({ columns: 4 })

    expect(gesture!.drag(dragEvent(4, 3, 2, 2))).toEqual({
      autoscroll: 'none',
      selectionChanged: true,
      selectionInstalled: true,
    })
    expect(gesture!.getSelection()).toBe('bcdefgh\nijklmnop\nqr')
    expect(gesture!.coordinates()).toEqual({
      end: { x: 1, y: 4 },
      rectangle: false,
      start: { x: 1, y: 0 },
    })
  })

  it('disposes idempotently, rejects later use, and tolerates terminal-first cleanup', async () => {
    const terminal = await createSelectionTerminal(8, 3)
    const activeGesture = gesture!

    activeGesture.dispose()
    expect(() => activeGesture.dispose()).not.toThrow()
    expect(() => activeGesture.coordinates()).toThrow('selection gesture has been disposed')

    const terminalFirst = new GhosttySelectionGesture(terminal)
    terminal.write('tracked anchor')
    terminalFirst.press(pressEvent(0, 0, 1_000_000_000n))
    terminal.dispose()
    expect(() => terminalFirst.dispose()).not.toThrow()
    expect(() => terminalFirst.dispose()).not.toThrow()
  })
})
