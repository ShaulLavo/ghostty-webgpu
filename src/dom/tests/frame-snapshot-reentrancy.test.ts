import { afterEach, expect, it } from 'vitest'
import { attachCanvasImage, observeDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { FrameObserver } from '../../render/shared/frame-observer.js'
import { TerminalSession } from '../../term/session.js'
import { CanvasImageRelay } from '../canvas-image.js'
import { LocalTerminalExecution } from '../execution-local.js'
import { calculateTerminalFittedFont } from '../fit.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

type Snapshot = Parameters<LocalTerminalExecution['submit']>[0]

async function createTerminal(bidi: boolean, retainDisplayedText: boolean) {
  const session = await TerminalSession.create<Event>({
    bidi,
    appearance: { grid: { columns: 20, rows: 4 } },
  })
  const execution = new LocalTerminalExecution(session)
  cleanups.push(() => execution.dispose())
  execution.commitLayout(
    calculateTerminalFittedFont(
      session.appearance.font,
      { advanceWidth: 8, fontAscent: 10, fontDescent: 3 },
      1,
    ),
    { top: 0, right: 0, bottom: 0, left: 0 },
  )
  const reported: unknown[] = []
  const relay = new CanvasImageRelay((cause) => reported.push(cause))
  cleanups.push(() => relay.dispose())
  let publications = 0
  // Same private options the main terminal passes to its GPU renderer (terminal.ts:1167-1169).
  const observer = new FrameObserver({
    rows: 4,
    [attachCanvasImage]: () => relay.attach(),
    [observeDisplayedFrame]: (snapshot: Snapshot) => {
      execution.submit(snapshot)
      publications += 1
    },
    retainDisplayedText,
  })
  cleanups.push(() => observer.dispose())
  observer.activateCanvasImage()
  // Mirrors terminal.ts handleSelection -> renderer notifySelectionChange -> frames.invalidate().
  const selection = session.on('selection', () => observer.invalidate())
  cleanups.push(() => selection.dispose())
  const state = session.renderState
  const capture = () => {
    const frame = observer.capture(state, state.readCursor(), undefined, [0, 1, 2, 3])
    state.acknowledge()
    frame.accept()
    return frame
  }
  return {
    session,
    execution,
    state,
    relay,
    reported,
    capture,
    get publications() {
      return publications
    },
  }
}

function rowText(rows: readonly { readonly text: string }[] | undefined) {
  return rows?.map((row) => row.text.trimEnd())
}

it.each([
  { damaged: true, readFirst: false },
  { damaged: true, readFirst: true },
  { damaged: false, readFirst: false },
  { damaged: false, readFirst: true },
])(
  'reads frameSnapshot from a canvas-image listener during a retained publication, damaged $damaged, prior read $readFirst',
  async ({ damaged, readFirst }) => {
    const terminal = await createTerminal(false, true)
    const { execution, state } = terminal
    execution.write('\x1b[?25lone')
    state.update()
    terminal.capture().notify('drawn')
    expect(terminal.publications).toBe(1)
    const first = readFirst ? execution.frameSnapshot() : undefined
    if (readFirst) expect(rowText(first?.rows)).toEqual(['one', '', '', ''])
    const firstVersion = execution.submittedFrame?.snapshotVersion

    const seen: unknown[] = []
    terminal.relay.subscribe(() => {
      seen.push(execution.frameSnapshot())
    })
    if (damaged) execution.write('\r\ntwo')
    state.update()
    expect(state.snapshotVersion === firstVersion).toBe(!damaged)
    terminal.capture().notify('drawn')

    expect(terminal.publications).toBe(2)
    expect(rowText(execution.frameSnapshot()?.rows)).toEqual(
      damaged ? ['one', 'two', '', ''] : ['one', '', '', ''],
    )
    expect(terminal.reported).toEqual([])
    expect(seen).toHaveLength(1)
    // The listener runs before the new frame is submitted; it may see the previous frame or nothing.
    const read = seen[0] as ReturnType<LocalTerminalExecution['frameSnapshot']>
    if (read) expect(rowText(read.rows)).toEqual(['one', '', '', ''])
    if (readFirst && damaged) expect(read).toBe(first)
  },
)

it('reads frameSnapshot from a canvas-image listener without native retention', async () => {
  const terminal = await createTerminal(false, false)
  const { execution, state } = terminal
  execution.write('\x1b[?25lone')
  state.update()
  terminal.capture().notify('drawn')
  const seen: unknown[] = []
  terminal.relay.subscribe(() => {
    seen.push(execution.frameSnapshot())
  })
  execution.write('\r\ntwo')
  state.update()
  terminal.capture().notify('drawn')

  expect(terminal.publications).toBe(2)
  expect(terminal.reported).toEqual([])
  expect(seen).toEqual([undefined])
})

const pressInput = {
  viewport: { x: 5, y: 3 },
  position: { x: 45, y: 35 },
  repeatDistance: 10,
  repeatIntervalNanoseconds: 500_000_000n,
  timeNanoseconds: 1_000_000_000n,
}

const mouseInput = {
  event: { action: 'press', button: 'left', x: 45, y: 35 },
  state: {
    anyButtonPressed: false,
    geometry: {
      cellHeight: 10,
      cellWidth: 10,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      screenHeight: 40,
      screenWidth: 200,
    },
  },
} as const

it.each(['mouse', 'press'] as const)(
  'keeps BiDi submission metadata with its text when a canvas-image listener writes and sends %s input',
  async (route) => {
    const terminal = await createTerminal(true, true)
    const { execution, state } = terminal
    execution.write('\x1b[?25l\x1b[?1000h\x1b[?1006hone')
    state.update()
    terminal.capture().notify('drawn')
    execution.write('\r\ntwo')
    state.update()
    const capturedVersion = state.snapshotVersion
    const frame = terminal.capture()

    const versions: (number | undefined)[] = []
    terminal.relay.subscribe(() => {
      execution.write('\r\nthree')
      if (route === 'mouse') execution.mouse(mouseInput)
      else execution.selectionPress(pressInput)
      versions.push(state.snapshotVersion)
    })
    frame.notify('drawn')

    expect(terminal.reported).toEqual([])
    expect(capturedVersion).toBe(2)
    expect(versions).toEqual([3])
    expect(execution.getSelection()).toBeUndefined()
    expect(terminal.publications).toBe(2)
    expect(rowText(execution.textFrame()?.rows)).toEqual(['one', 'two', '', ''])
    expect.soft(execution.submittedFrame?.snapshotVersion).toBe(capturedVersion)
    const snapshot = execution.frameSnapshot()
    if (snapshot) expect.soft(rowText(snapshot.rows)).toEqual(['one', 'two', '', ''])
    const viewport = execution.captureViewport(800, 400)
    if (viewport) expect.soft(JSON.parse(viewport).rows[2]).toEqual([])
  },
)

it('keeps GPU submission revision and scrollbar with its text when a canvas-image listener writes', async () => {
  const terminal = await createTerminal(false, true)
  const { execution, state } = terminal
  execution.write('\x1b[?25lone')
  state.update()
  terminal.capture().notify('drawn')
  execution.write('\r\ntwo')
  state.update()
  const capturedVersion = state.snapshotVersion
  const capturedRevision = execution.revision
  const capturedScrollbar = { ...execution.scrollbar }
  const frame = terminal.capture()

  terminal.relay.subscribe(() => {
    execution.write('\r\n3\r\n4\r\n5')
  })
  frame.notify('drawn')

  expect(terminal.reported).toEqual([])
  expect(state.snapshotVersion).toBe(capturedVersion)
  expect(execution.revision).toBeGreaterThan(capturedRevision)
  expect(execution.scrollbar.total).toBeGreaterThan(capturedScrollbar.total)
  expect(terminal.publications).toBe(2)
  expect(rowText(execution.textFrame()?.rows)).toEqual(['one', 'two', '', ''])
  expect.soft(execution.submittedFrame?.nativeRevision).toBe(capturedRevision)
  expect.soft(execution.submittedFrame?.scrollbar).toEqual(capturedScrollbar)
  const viewport = execution.captureViewport(800, 400)
  if (viewport) expect.soft(JSON.parse(viewport).scrollbar).toEqual(capturedScrollbar)
})

it('drops a publication whose canvas-image listener changes the selection', async () => {
  const terminal = await createTerminal(true, true)
  const { execution, state } = terminal
  execution.write('\x1b[?25lone two')
  state.update()
  terminal.capture().notify('drawn')
  const submitted = execution.submittedFrame
  execution.selectRange({ x: 0, y: 0 }, { x: 2, y: 0 })
  state.update()
  const frame = terminal.capture()

  terminal.relay.subscribe(() => {
    execution.clearSelection()
  })
  frame.notify('drawn')

  expect(terminal.reported).toEqual([])
  expect(terminal.publications).toBe(1)
  expect(execution.submittedFrame).toBe(submitted)
})
