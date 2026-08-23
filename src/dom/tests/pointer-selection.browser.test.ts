import { afterEach, describe, expect, it } from 'vitest'
import {
  createTerminalPointerController,
  projectPointerPosition,
  type CommittedPointerLayout,
  type TerminalPointerController,
  type TerminalPointerSession,
} from '../pointer.js'
import {
  createTerminalSelectionController,
  type TerminalSelectionClock,
  type TerminalSelectionController,
} from '../selection.js'
import { TerminalSession } from '../../term/session.js'
import type { TerminalGrid } from '../../term/types.js'

const decoder = new TextDecoder()
const escape = '\u001b'

interface CaptureHarness {
  readonly captured: Set<number>
  lose(pointerId: number): void
}

interface BrowserHarness {
  readonly canvas: HTMLCanvasElement
  readonly capture: CaptureHarness
  readonly clock: FakeSelectionClock
  readonly data: string[]
  readonly layout: CommittedPointerLayout
  readonly pointer: TerminalPointerController
  readonly selection: TerminalSelectionController
  readonly session: TerminalSession
  readonly selectionChanges: { value: number }
}

interface HarnessOptions {
  readonly onPointerError?: (cause: unknown, operation: string) => void
  readonly pointerSession?: (session: TerminalSession) => TerminalPointerSession
}

class FakeSelectionClock implements TerminalSelectionClock {
  private nextHandle = 1
  private now = 1_000_000_000n
  readonly timers = new Map<number, () => void>()

  clearInterval(handle: number): void {
    this.timers.delete(handle)
  }

  nowNanoseconds(): bigint {
    return this.now
  }

  setInterval(callback: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.timers.set(handle, callback)
    return handle
  }

  advance(milliseconds: number): void {
    this.now += BigInt(Math.round(milliseconds * 1_000_000))
  }

  flushInterval(): void {
    const callback = this.timers.values().next().value
    if (!callback) throw new Error('No pending selection interval')
    callback()
  }
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  document.body.append(canvas)
  return canvas
}

function installCaptureHarness(canvas: HTMLCanvasElement): CaptureHarness {
  const captured = new Set<number>()
  Object.defineProperties(canvas, {
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.has(pointerId),
    },
    releasePointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.delete(pointerId),
    },
    setPointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.add(pointerId),
    },
  })
  return {
    captured,
    lose(pointerId) {
      captured.delete(pointerId)
      canvas.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId }))
    },
  }
}

function committedLayout(
  canvas: HTMLCanvasElement,
  overrides: {
    readonly cellHeight?: number
    readonly cellWidth?: number
    readonly columns?: number
    readonly paddingBottom?: number
    readonly paddingLeft?: number
    readonly paddingRight?: number
    readonly paddingTop?: number
    readonly pixelRatio?: number
    readonly rows?: number
  } = {},
): CommittedPointerLayout {
  const cellHeight = overrides.cellHeight ?? 20
  const cellWidth = overrides.cellWidth ?? 10
  const columns = overrides.columns ?? 8
  const pixelRatio = overrides.pixelRatio ?? 1
  const rows = overrides.rows ?? 3
  const deviceCellHeight = Math.round(cellHeight * pixelRatio)
  const deviceCellWidth = Math.round(cellWidth * pixelRatio)
  const paddingBottom = overrides.paddingBottom ?? 13
  const paddingLeft = overrides.paddingLeft ?? 5
  const paddingRight = overrides.paddingRight ?? 11
  const paddingTop = overrides.paddingTop ?? 7
  const screenHeight = paddingTop + rows * deviceCellHeight + paddingBottom
  const screenWidth = paddingLeft + columns * deviceCellWidth + paddingRight
  canvas.width = screenWidth
  canvas.height = screenHeight
  canvas.style.width = `${screenWidth / pixelRatio}px`
  canvas.style.height = `${screenHeight / pixelRatio}px`
  return Object.freeze({
    canvas,
    grid: Object.freeze({ cellHeight, cellWidth, columns, pixelRatio, rows }),
    physical: Object.freeze({
      deviceCellHeight,
      deviceCellWidth,
      paddingBottom,
      paddingLeft,
      paddingRight,
      paddingTop,
      screenHeight,
      screenWidth,
    }),
  })
}

async function createHarness(
  layoutOptions: Parameters<typeof committedLayout>[1] = {},
  options: HarnessOptions = {},
): Promise<BrowserHarness> {
  const canvas = createCanvas()
  const capture = installCaptureHarness(canvas)
  const layout = committedLayout(canvas, layoutOptions)
  const grid: TerminalGrid = {
    cellHeight: layout.grid.cellHeight,
    cellWidth: layout.grid.cellWidth,
    columns: layout.grid.columns,
    pixelRatio: layout.grid.pixelRatio,
    rows: layout.grid.rows,
  }
  const session = await TerminalSession.create({ appearance: { grid } })
  const clock = new FakeSelectionClock()
  const selectionChanges = { value: 0 }
  const selection = createTerminalSelectionController({
    clock,
    onSelectionChange: () => {
      selectionChanges.value += 1
    },
    session,
  })
  const pointer = createTerminalPointerController({
    canvas,
    getLayout: () => layout,
    onError: options.onPointerError,
    selection,
    session:
      options.pointerSession?.(session) ??
      ({
        mouse: (input) => session.mouse(input),
        mouseTracking: () => session.mouseTracking,
        resetMouseTracking: () => session.resetMouseTracking(),
        scrollBy: (delta) => session.scrollBy(delta),
      } satisfies TerminalPointerSession),
  })
  const data: string[] = []
  session.on('data', ({ bytes }) => data.push(decoder.decode(bytes)))
  cleanups.push(() => {
    pointer.dispose()
    session.dispose()
    canvas.remove()
  })
  return { canvas, capture, clock, data, layout, pointer, selection, session, selectionChanges }
}

function clientPoint(
  layout: CommittedPointerLayout,
  rawX: number,
  rawY: number,
): { clientX: number; clientY: number } {
  const bounds = layout.canvas.getBoundingClientRect()
  return {
    clientX: bounds.left + rawX / layout.grid.pixelRatio,
    clientY: bounds.top + rawY / layout.grid.pixelRatio,
  }
}

function dispatchPointer(
  layout: CommittedPointerLayout,
  type: string,
  rawX: number,
  rawY: number,
  init: PointerEventInit = {},
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    ...clientPoint(layout, rawX, rawY),
    ...init,
  })
  layout.canvas.dispatchEvent(event)
  return event
}

function dispatchWheel(
  layout: CommittedPointerLayout,
  rawX: number,
  rawY: number,
  init: WheelEventInit,
): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ...clientPoint(layout, rawX, rawY),
    ...init,
  })
  layout.canvas.dispatchEvent(event)
  return event
}

function cellPosition(
  layout: CommittedPointerLayout,
  column: number,
  row: number,
): { x: number; y: number } {
  return {
    x: layout.physical.paddingLeft + column * layout.physical.deviceCellWidth + 1,
    y: layout.physical.paddingTop + row * layout.physical.deviceCellHeight + 1,
  }
}

function trailingCellPosition(
  layout: CommittedPointerLayout,
  column: number,
  row: number,
): { x: number; y: number } {
  return {
    x: layout.physical.paddingLeft + (column + 1) * layout.physical.deviceCellWidth - 1,
    y: layout.physical.paddingTop + (row + 1) * layout.physical.deviceCellHeight - 1,
  }
}

function clickCell(
  harness: BrowserHarness,
  column: number,
  row: number,
  init: PointerEventInit = {},
): void {
  const point = cellPosition(harness.layout, column, row)
  dispatchPointer(harness.layout, 'pointerdown', point.x, point.y, {
    button: 0,
    buttons: 1,
    ...init,
  })
  dispatchPointer(harness.layout, 'pointerup', point.x, point.y, {
    button: 0,
    buttons: 0,
    ...init,
  })
}

describe('physical pointer projections', () => {
  it('keeps raw mouse pixels while subtracting asymmetric padding only for selection viewport', () => {
    const canvas = createCanvas()
    const layout = committedLayout(canvas, {
      paddingBottom: 18,
      paddingLeft: 6,
      paddingRight: 14,
      paddingTop: 10,
      pixelRatio: 2,
    })
    const raw = { x: layout.physical.paddingLeft + 3, y: layout.physical.paddingTop + 5 }
    const projection = projectPointerPosition(clientPoint(layout, raw.x, raw.y), layout)
    cleanups.push(() => canvas.remove())

    expect(projection.raw).toEqual(raw)
    expect(projection.mouse).toMatchObject({ x: raw.x, y: raw.y })
    expect(projection.mouse.geometry).toMatchObject({
      paddingBottom: 18,
      paddingTop: 10,
      screenHeight: layout.physical.screenHeight,
    })
    expect(projection.selection.viewport).toEqual({ x: 0, y: 0 })
    expect(projection.selection.position).toEqual(raw)
    expect(projection.selection.geometry).toEqual({
      cellWidth: layout.physical.deviceCellWidth,
      columns: layout.grid.columns,
      paddingLeft: 6,
      screenHeight: layout.physical.screenHeight,
    })
  })
})

describe('native mouse routing', () => {
  it('encodes SGR cell and pixel coordinates and pairs captured outside release', async () => {
    const harness = await createHarness({
      paddingBottom: 18,
      paddingLeft: 6,
      paddingRight: 14,
      paddingTop: 10,
      pixelRatio: 2,
    })
    const point = {
      x: harness.layout.physical.paddingLeft + 6,
      y: harness.layout.physical.paddingTop + 10,
    }
    harness.session.write(`${escape}[?1000h${escape}[?1006h`)

    dispatchPointer(harness.layout, 'pointerdown', point.x, point.y, {
      button: 0,
      buttons: 1,
    })
    expect(harness.capture.captured.has(1)).toBe(true)
    expect(harness.data).toEqual([`${escape}[<0;1;1M`])

    dispatchPointer(
      harness.layout,
      'pointerup',
      harness.layout.physical.screenWidth + 20,
      harness.layout.physical.screenHeight + 20,
      { button: 0, buttons: 0 },
    )
    expect(harness.capture.captured.size).toBe(0)
    expect(harness.data.at(-1)).toBe(`${escape}[<0;8;3m`)

    harness.session.write(`${escape}[?1016h`)
    harness.data.length = 0
    dispatchPointer(harness.layout, 'pointerdown', point.x, point.y, {
      button: 0,
      buttons: 1,
    })
    expect(harness.data).toEqual([`${escape}[<0;6;10M`])
  })

  it('preserves native same-cell dedupe and accepts the same position after a VT write', async () => {
    const harness = await createHarness()
    const point = cellPosition(harness.layout, 1, 1)
    harness.session.write(`${escape}[?1003h${escape}[?1006h`)

    dispatchPointer(harness.layout, 'pointermove', point.x, point.y, {
      button: -1,
      buttons: 0,
    })
    dispatchPointer(harness.layout, 'pointermove', point.x, point.y, {
      button: -1,
      buttons: 0,
    })
    expect(harness.data).toEqual([`${escape}[<35;2;2M`])

    harness.session.write('x')
    dispatchPointer(harness.layout, 'pointermove', point.x, point.y, {
      button: -1,
      buttons: 0,
    })
    expect(harness.data).toEqual([`${escape}[<35;2;2M`, `${escape}[<35;2;2M`])
  })

  it('switches tracked drags exclusively to Shift selection and cleans lost capture state', async () => {
    const harness = await createHarness()
    harness.session.write(`abcdef${escape}[?1003h${escape}[?1006h`)
    const start = cellPosition(harness.layout, 0, 0)
    const end = trailingCellPosition(harness.layout, 2, 0)

    dispatchPointer(harness.layout, 'pointerdown', start.x, start.y, {
      button: 0,
      buttons: 1,
    })
    expect(harness.pointer.owner).toBe('mouse')
    dispatchPointer(harness.layout, 'pointermove', start.x, start.y, {
      button: -1,
      buttons: 1,
      shiftKey: true,
    })
    expect(harness.pointer.owner).toBe('selection')
    expect(harness.data).toEqual([`${escape}[<0;1;1M`, `${escape}[<4;1;1m`])

    dispatchPointer(harness.layout, 'pointermove', end.x, end.y, {
      button: -1,
      buttons: 1,
      shiftKey: true,
    })
    expect(harness.session.getSelection()).toBe('abc')
    const installed = harness.session.getSelection()
    dispatchPointer(harness.layout, 'pointermove', end.x, end.y, {
      button: -1,
      buttons: 1,
      shiftKey: false,
    })
    expect(harness.pointer.owner).toBe('mouse')
    expect(harness.selection.active).toBe(false)
    expect(harness.data.at(-1)).toBe(`${escape}[<0;3;1M`)

    harness.capture.lose(1)

    expect(harness.pointer.owner).toBe('none')
    expect(harness.pointer.pressedButtonCount).toBe(0)
    expect(harness.selection.active).toBe(false)
    expect(harness.session.getSelection()).toBe(installed)
    expect(harness.data.at(-1)).toBe(`${escape}[<0;3;1m`)

    dispatchPointer(harness.layout, 'pointermove', end.x, end.y, {
      button: -1,
      buttons: 0,
    })
    expect(harness.data.at(-1)).toBe(`${escape}[<35;3;1M`)
  })

  it('contains synchronous session failures and reports an operation-tagged error', async () => {
    const failure = new Error('mouse failed')
    const errors: Array<{ cause: unknown; operation: string }> = []
    const harness = await createHarness(
      {},
      {
        onPointerError: (cause, operation) => errors.push({ cause, operation }),
        pointerSession: (session) => ({
          mouse: () => {
            throw failure
          },
          mouseTracking: () => session.mouseTracking,
          resetMouseTracking: () => session.resetMouseTracking(),
          scrollBy: (delta) => session.scrollBy(delta),
        }),
      },
    )
    harness.session.write(`${escape}[?1000h${escape}[?1006h`)
    const point = cellPosition(harness.layout, 0, 0)

    dispatchPointer(harness.layout, 'pointerdown', point.x, point.y, {
      button: 0,
      buttons: 1,
    })

    expect(errors[0]).toEqual({ cause: failure, operation: 'pointer.pointerdown' })
    expect(errors[1]).toEqual({
      cause: failure,
      operation: 'pointer.pointerdown.cleanup.mouseRelease',
    })
    expect(harness.pointer.owner).toBe('none')
    expect(harness.pointer.pressedButtonCount).toBe(0)
    expect(harness.capture.captured.size).toBe(0)
  })
})

describe('wheel routing', () => {
  it('accumulates pixel residuals for viewport scrolling and emits native wheel pairs when tracked', async () => {
    const harness = await createHarness()
    harness.session.write('0\r\n1\r\n2\r\n3\r\n4\r\n5')
    const initialOffset = harness.session.scrollbar.offset
    const point = cellPosition(harness.layout, 0, 0)

    dispatchWheel(harness.layout, point.x, point.y, {
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: -harness.layout.grid.cellHeight / 2,
    })
    expect(harness.session.scrollbar.offset).toBe(initialOffset)
    expect(harness.pointer.wheelResidual).toBe(-0.5)

    dispatchWheel(harness.layout, point.x, point.y, {
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: -harness.layout.grid.cellHeight / 2,
    })
    expect(harness.session.scrollbar.offset).toBe(initialOffset - 1)
    expect(harness.pointer.wheelResidual).toBe(0)

    harness.session.write(`${escape}[?1000h${escape}[?1006h`)
    harness.data.length = 0
    dispatchWheel(harness.layout, point.x, point.y, {
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: -1,
    })
    expect(harness.data).toEqual([`${escape}[<64;1;1M`, `${escape}[<64;1;1m`])

    const beforeShift = harness.session.scrollbar.offset
    dispatchWheel(harness.layout, point.x, point.y, {
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 1,
      shiftKey: true,
    })
    expect(harness.session.scrollbar.offset).toBe(beforeShift + 1)
    expect(harness.data).toHaveLength(2)
  })
})

describe('native selection routing', () => {
  it('uses native word and line click repetition at the first padded row', async () => {
    const harness = await createHarness({
      columns: 20,
      paddingBottom: 17,
      paddingTop: 9,
      rows: 4,
    })
    harness.session.write('alpha beta gamma\r\nsecond row')

    clickCell(harness, 7, 0)
    harness.clock.advance(100)
    clickCell(harness, 7, 0)
    expect(harness.session.getSelection()).toBe('beta')
    expect(harness.session.selectionCoordinates()?.start.y).toBe(0)

    harness.clock.advance(600)
    clickCell(harness, 3, 1)
    harness.clock.advance(100)
    clickCell(harness, 3, 1)
    harness.clock.advance(100)
    clickCell(harness, 3, 1)
    expect(harness.session.getSelection()).toBe('second row')

    const samePosition = cellPosition(harness.layout, 1, 0)
    harness.session.write(`${escape}[?1000h${escape}[?1006h`)
    harness.data.length = 0
    dispatchPointer(harness.layout, 'pointerdown', samePosition.x, samePosition.y, {
      button: 0,
      buttons: 1,
    })
    expect(harness.data).toEqual([`${escape}[<0;2;1M`])
  })

  it('installs native rectangular selections without a DOM range model', async () => {
    const harness = await createHarness({ columns: 5, rows: 3 })
    harness.session.write('abcde\r\nfghij\r\nklmno')
    const start = cellPosition(harness.layout, 1, 0)
    const end = trailingCellPosition(harness.layout, 2, 2)
    const rectangle = { altKey: true, ctrlKey: true }

    dispatchPointer(harness.layout, 'pointerdown', start.x, start.y, {
      button: 0,
      buttons: 1,
      ...rectangle,
    })
    dispatchPointer(harness.layout, 'pointermove', end.x, end.y, {
      button: -1,
      buttons: 1,
      ...rectangle,
    })
    dispatchPointer(harness.layout, 'pointerup', end.x, end.y, {
      button: 0,
      buttons: 0,
      ...rectangle,
    })

    expect(harness.session.getSelection()).toBe('bc\ngh\nlm')
    expect(harness.session.selectionCoordinates()?.rectangle).toBe(true)
  })

  it('autoscrolls through history on the injected clock and exhaustively cancels timers', async () => {
    const harness = await createHarness()
    harness.session.write('0\r\n1\r\n2\r\n3\r\n4\r\n5')
    harness.session.scrollToTop()
    const start = cellPosition(harness.layout, 0, 0)
    const outsideX = trailingCellPosition(harness.layout, 0, 0).x
    const below = harness.layout.physical.screenHeight + 5

    dispatchPointer(harness.layout, 'pointerdown', start.x, start.y, {
      button: 0,
      buttons: 1,
    })
    dispatchPointer(harness.layout, 'pointermove', outsideX, below, {
      button: -1,
      buttons: 1,
    })
    expect(harness.selection.hasPendingAutoscroll).toBe(true)
    expect(harness.clock.timers.size).toBe(1)
    const changesBeforeTick = harness.selectionChanges.value

    harness.clock.flushInterval()
    expect(harness.session.scrollbar.offset).toBe(1)
    expect(harness.session.getSelection()).toBe('0\n1\n2\n3')
    expect(harness.selectionChanges.value).toBe(changesBeforeTick + 1)

    harness.capture.lose(1)
    expect(harness.selection.hasPendingAutoscroll).toBe(false)
    expect(harness.clock.timers.size).toBe(0)
    expect(harness.capture.captured.size).toBe(0)

    dispatchPointer(harness.layout, 'pointerdown', start.x, start.y, {
      button: 0,
      buttons: 1,
    })
    dispatchPointer(harness.layout, 'pointermove', outsideX, -5, {
      button: -1,
      buttons: 1,
    })
    expect(harness.clock.timers.size).toBe(1)
    harness.canvas.ownerDocument.defaultView?.dispatchEvent(new Event('blur'))

    expect(harness.pointer.owner).toBe('none')
    expect(harness.selection.hasPendingAutoscroll).toBe(false)
    expect(harness.clock.timers.size).toBe(0)
    expect(harness.capture.captured.size).toBe(0)

    dispatchPointer(harness.layout, 'pointerdown', start.x, start.y, {
      button: 0,
      buttons: 1,
    })
    dispatchPointer(harness.layout, 'pointermove', outsideX, below, {
      button: -1,
      buttons: 1,
    })
    expect(harness.clock.timers.size).toBe(1)
    harness.pointer.dispose()

    expect(harness.selection.hasPendingAutoscroll).toBe(false)
    expect(harness.clock.timers.size).toBe(0)
    expect(harness.capture.captured.size).toBe(0)
  })
})
