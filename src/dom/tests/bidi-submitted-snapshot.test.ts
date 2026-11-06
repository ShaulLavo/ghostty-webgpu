import { afterEach, expect, it, vi } from 'vitest'
import { captureSubmission, displayedRows } from '../../core/frame-observers.js'
import { CellPin } from '../../bidi/pin.js'
import { CanvasImageRelay } from '../canvas-image.js'
import { attachCanvasImage } from '../../render/shared/displayed-frame.js'
import type { RenderCell } from '../../core/types.js'
import { observeDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { FrameObserver } from '../../render/shared/frame-observer.js'
import { TerminalSession } from '../../term/session.js'
import { LocalTerminalExecution } from '../execution-local.js'
import { calculateTerminalFittedFont } from '../fit.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

function selectedColumns(cells: readonly Pick<RenderCell, 'x' | 'selected'>[] | undefined) {
  return cells?.filter((cell) => cell.selected).map((cell) => cell.x)
}

it.each([
  { entry: 'main', readBeforeClear: false },
  { entry: 'main', readBeforeClear: true },
  { entry: 'worker', readBeforeClear: false },
  { entry: 'worker', readBeforeClear: true },
])(
  'keeps submitted BiDi selection after clear through $entry publication, prior read $readBeforeClear',
  async ({ entry, readBeforeClear }) => {
    const session = await TerminalSession.create<Event>({
      bidi: true,
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
    let publications = 0
    const publish = (snapshot: Parameters<LocalTerminalExecution['submit']>[0]) => {
      execution.submit(snapshot)
      publications += 1
    }
    const observer = new FrameObserver({
      rows: 4,
      ...(entry === 'main'
        ? { [observeDisplayedFrame]: publish, retainDisplayedText: true }
        : { onTextFrame: publish, needsFrameRows: () => true }),
    })
    cleanups.push(() => observer.dispose())
    execution.write('\x1b[?25lab שלום cd')
    execution.selectionPress({
      viewport: { x: 3, y: 0 },
      position: { x: 35, y: 5 },
      repeatDistance: 10,
      repeatIntervalNanoseconds: 500_000_000n,
      timeNanoseconds: 1_000_000_000n,
    })
    execution.selectionDrag({
      viewport: { x: 1, y: 0 },
      position: { x: 15, y: 5 },
      geometry: { columns: 20, cellWidth: 10, paddingLeft: 0, screenHeight: 80 },
    })
    execution.selectionRelease({ x: 1, y: 0 })
    const state = session.renderState
    state.update()
    expect(state.renderHeld).toBe(false)
    expect(execution.getSelection()).toBe('b ם')
    expect(selectedColumns(state.readRows()[0]?.cells)).toEqual([1, 2, 6])
    const frame = observer.capture(state, state.readCursor(), undefined, [0, 1, 2, 3])
    state.acknowledge()
    frame.accept()
    frame.notify()
    expect(publications).toBe(1)
    expect(execution.captureViewport(800, 400)).toEqual(expect.any(String))
    const submitted = execution.submittedFrame
    expect(submitted).toBeDefined()
    expect(execution.textFrame()?.rows[0]?.text.trimEnd()).toBe('ab שלום cd')
    if (readBeforeClear)
      expect(selectedColumns(execution.frameSnapshot()?.rows[0]?.renderCells)).toEqual([1, 2, 6])

    execution.clearSelection()
    expect(execution.getSelection()).toBeUndefined()
    expect(execution.captureViewport(800, 400)).toBeUndefined()
    expect(execution.submittedFrame).toBe(submitted)
    expect(state.snapshotVersion).toBe(submitted?.snapshotVersion)
    expect(execution.revision).not.toBe(submitted?.nativeRevision)
    expect(publications).toBe(1)
    const snapshot = execution.frameSnapshot()
    expect(snapshot).toBeDefined()
    expect(snapshot?.renderHeld).toBe(false)
    expect(snapshot?.rows[0]?.text.trimEnd()).toBe('ab שלום cd')
    expect(snapshot?.cursor).toEqual(submitted?.cursor)
    expect(snapshot?.rows.map((row) => row.cells)).toEqual(
      execution.textFrame()?.rows.map((row) => row.cells),
    )
    expect(snapshot?.rows.map((row) => row.continuations)).toEqual(
      execution.textFrame()?.rows.map((row) => row.continuations),
    )
    expect(selectedColumns(snapshot?.rows[0]?.renderCells)).toEqual([1, 2, 6])
  },
)

function nativeVersion(state: TerminalSession['renderState']): number {
  const version = state.snapshotVersion
  if (version === undefined) throw new Error('Missing native snapshot version')
  return version
}

async function submittedFixture(entry = 'main', bidi = true) {
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
  const relay = new CanvasImageRelay((cause) => {
    throw cause
  })
  const publications: Parameters<LocalTerminalExecution['submit']>[0][] = []
  const publish = (snapshot: Parameters<LocalTerminalExecution['submit']>[0]) => {
    publications.push(snapshot)
    execution.submit(snapshot)
  }
  const observer = new FrameObserver({
    rows: 4,
    [captureSubmission]: () => execution.sampleSubmission(),
    [attachCanvasImage]: () => relay.attach(),
    ...(entry === 'main'
      ? { [observeDisplayedFrame]: publish, retainDisplayedText: true }
      : { onTextFrame: publish, needsFrameRows: () => true }),
  })
  observer.activateCanvasImage()
  cleanups.push(() => {
    observer.dispose()
    relay.dispose()
  })
  execution.write('\x1b[?25lab שלום cd')
  const state = session.renderState
  const capture = () => observer.capture(state, state.readCursor(), undefined, [0, 1, 2, 3])
  const publishFrame = () => {
    state.update()
    const frame = capture()
    state.acknowledge()
    frame.accept()
    frame.notify('drawn')
  }
  return { session, execution, state, observer, relay, publications, capture, publishFrame }
}

function visualDrag(execution: LocalTerminalExecution, start = 3, end = 1, y = 0) {
  execution.selectionPress({
    viewport: { x: start, y },
    position: { x: start * 10 + 5, y: y * 20 + 5 },
    repeatDistance: 10,
    repeatIntervalNanoseconds: 500_000_000n,
    timeNanoseconds: 1_000_000_000n,
  })
  execution.selectionDrag({
    viewport: { x: end, y },
    position: { x: end * 10 + 5, y: y * 20 + 5 },
    geometry: { columns: 20, cellWidth: 10, paddingLeft: 0, screenHeight: 80 },
  })
  execution.selectionRelease({ x: end, y })
}

function snapshotSelection(execution: LocalTerminalExecution) {
  return execution.frameSnapshot()?.rows.flatMap((row) => {
    const columns = selectedColumns(row.renderCells)!
    return columns.length ? [{ y: row.y, columns }] : []
  })
}

it('captures before a reentrant canvas-image listener clears selection', async () => {
  const f = await submittedFixture()
  f.publishFrame()
  const versionA = nativeVersion(f.state)
  visualDrag(f.execution)
  f.state.update()
  expect(f.state.snapshotVersion).toBeGreaterThan(versionA)
  let during: ReturnType<LocalTerminalExecution['frameSnapshot']>
  let notifications = 0
  f.relay.subscribe(() => {
    f.execution.clearSelection()
    during = f.execution.frameSnapshot()
    notifications += 1
  })
  const frame = f.capture()
  f.state.acknowledge()
  frame.accept()
  frame.notify('drawn')
  expect(notifications).toBe(1)
  expect(during).toBeUndefined()
  expect(f.publications).toHaveLength(2)
  expect(f.execution.getSelection()).toBeUndefined()
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
})

it.each(['main', 'worker'])('preserves native programmatic selection through %s', async (entry) => {
  const f = await submittedFixture(entry)
  f.execution.selectRange({ x: 0, y: 0 }, { x: 2, y: 0 })
  f.publishFrame()
  f.execution.clearSelection()
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [0, 1, 2] }])
})

it.each(['main', 'worker'])('owns the nonzero captured offset through %s', async (entry) => {
  const f = await submittedFixture(entry)
  f.execution.write('\x1b[2J\x1b[3;1Hab שלום cd')
  visualDrag(f.execution, 3, 1, 2)
  f.execution.write('\r\n'.repeat(5))
  f.execution.scrollToRow(1)
  f.publishFrame()
  expect(f.session.scrollbar.offset).toBe(1)
  const version = nativeVersion(f.state)
  f.execution.scrollToBottom()
  expect(f.session.scrollbar.offset).toBe(4)
  expect(f.state.snapshotVersion).toBe(version)
  expect(snapshotSelection(f.execution)).toEqual([{ y: 1, columns: [1, 2, 6] }])
})

it('keeps a submitted wide lead and its tail after clear', async () => {
  const f = await submittedFixture()
  f.execution.write('\r\x1b[2Ka界b שלום cd')
  visualDrag(f.execution, 1, 2)
  f.publishFrame()
  f.execution.clearSelection()
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2] }])
})

it('reuses held membership until output advances the native snapshot', async () => {
  const f = await submittedFixture()
  visualDrag(f.execution)
  f.publishFrame()
  f.execution.write('\x1b[?2026h\r\noutput')
  f.publishFrame()
  f.execution.clearSelection()
  const held = f.execution.frameSnapshot()
  expect(held?.renderHeld).toBe(true)
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
  f.execution.write('\x1b[?2026l')
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
  const cached = f.execution.frameSnapshot()
  const version = nativeVersion(f.state)
  f.state.update()
  expect(f.state.snapshotVersion).toBeGreaterThan(version)
  expect(f.execution.frameSnapshot()).toBe(cached)
  f.publishFrame()
  expect(snapshotSelection(f.execution)).toEqual([])
})

it('reads captured membership twice without borrowing live pins', async () => {
  const f = await submittedFixture()
  const point = vi.spyOn(CellPin.prototype, 'point')
  f.state.update()
  point.mockClear()
  f.publishFrame()
  expect(point).not.toHaveBeenCalled()
  visualDrag(f.execution)
  f.state.update()
  point.mockClear()
  const frame = f.capture()
  expect(point).toHaveBeenCalledTimes(3)
  f.state.acknowledge()
  frame.accept()
  frame.notify()
  point.mockClear()
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
  expect(point).not.toHaveBeenCalled()
  f.execution.clearSelection()
  point.mockClear()
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
  expect(point).not.toHaveBeenCalled()
})

it('does not publish discarded or superseded captured membership', async () => {
  const f = await submittedFixture()
  f.publishFrame()
  const previous = f.execution.textFrame()
  visualDrag(f.execution)
  f.state.update()
  f.capture().discard()
  const superseded = f.capture()
  f.observer.invalidate()
  superseded.accept()
  superseded.notify()
  expect(f.publications).toHaveLength(1)
  expect(f.execution.textFrame()).toBe(previous)
  f.execution.clearSelection()
  f.publishFrame()
  expect(f.publications).toHaveLength(2)
  expect(snapshotSelection(f.execution)).toEqual([])
})

it('preserves worker resubmission and structured cloning', async () => {
  const f = await submittedFixture('worker')
  visualDrag(f.execution)
  f.publishFrame()
  f.execution.clearSelection()
  f.execution.submit(f.execution.textFrame()!)
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
  const clone = structuredClone(f.execution.textFrame())
  expect(Object.getOwnPropertySymbols(clone!)).toEqual([])
  expect(structuredClone(f.execution.frameSnapshot())).toEqual(f.execution.frameSnapshot())
})

it('does not invoke the captured reader after disposal', async () => {
  const f = await submittedFixture()
  visualDrag(f.execution)
  f.publishFrame()
  f.execution.dispose()
  expect(f.execution.frameSnapshot()).toBeUndefined()
})

it('keeps the native captured grid after resize without update', async () => {
  const f = await submittedFixture()
  visualDrag(f.execution)
  f.publishFrame()
  const version = nativeVersion(f.state)
  f.execution.resize({ columns: 12 })
  expect(f.state.snapshotVersion).toBe(version)
  const snapshot = f.execution.frameSnapshot()
  expect(snapshot?.rows[0]?.cells).toHaveLength(20)
  expect(snapshot?.rows[0]?.text.trimEnd()).toBe('ab שלום cd')
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
  expect(f.execution.captureViewport(800, 400)).toBeUndefined()
})

it('keeps captured membership after a programmatic replacement', async () => {
  const f = await submittedFixture()
  visualDrag(f.execution)
  f.publishFrame()
  f.execution.selectRange({ x: 0, y: 0 }, { x: 0, y: 0 })
  expect(f.execution.getSelection()).toBe('a')
  expect(snapshotSelection(f.execution)).toEqual([{ y: 0, columns: [1, 2, 6] }])
})

it.each([false, true])(
  'preserves availability after native advancement, cached %s',
  async (cached) => {
    const f = await submittedFixture()
    visualDrag(f.execution)
    f.publishFrame()
    const previous = cached ? f.execution.frameSnapshot() : undefined
    const version = nativeVersion(f.state)
    f.execution.write('changed')
    f.state.update()
    expect(f.state.snapshotVersion).toBeGreaterThan(version)
    expect(f.execution.frameSnapshot()).toBe(previous)
  },
)

it('does not decorate a newer native snapshot with an older submitted mask', async () => {
  const f = await submittedFixture()
  visualDrag(f.execution)
  f.publishFrame()
  f.execution.write('\r\nB')
  f.state.update()
  const version = nativeVersion(f.state)
  const frame = f.capture()
  f.relay.subscribe(() => {
    f.execution.write('\r\nthree')
    f.execution.mouse({
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
    })
  })
  f.state.acknowledge()
  frame.accept()
  frame.notify('drawn')
  expect(f.state.snapshotVersion).toBeGreaterThan(version)
  expect(f.execution.submittedFrame?.snapshotVersion).toBe(version)
  expect(f.execution.frameSnapshot()).toBeUndefined()
  expect(f.execution.textFrame()?.rows[0]?.text.trimEnd()).toBe('ab שלום cd')
})

it('shares the native no-mask reader and preserves packed rows', async () => {
  const f = await submittedFixture()
  f.execution.selectRange({ x: 0, y: 0 }, { x: 2, y: 0 })
  f.publishFrame()
  const first = f.publications.at(-1)![displayedRows]
  expect(first).toBeDefined()
  expect(first!.readRows({ packed: true })[0]!.packed).toBeDefined()
  f.publishFrame()
  expect(f.publications.at(-1)![displayedRows]).toBe(first)
})

it('keeps non-BiDi submissions free of captured membership', async () => {
  const f = await submittedFixture('main', false)
  f.publishFrame()
  expect(Object.getOwnPropertySymbols(f.publications.at(-1)!)).not.toContain(displayedRows)
  expect(snapshotSelection(f.execution)).toEqual([])
  expect(f.execution.frameSnapshot()?.rows[0]?.text.trimEnd()).toBe('ab שלום cd')
})
