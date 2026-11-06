import { afterEach, expect, it } from 'vitest'
import type { RenderCell } from '../../core/types.js'
import { observeDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { FrameObserver } from '../../render/shared/frame-observer.js'
import { TerminalSession } from '../../term/session.js'
import { LocalTerminalExecution } from '../execution-local.js'
import { calculateTerminalFittedFont } from '../fit.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
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
