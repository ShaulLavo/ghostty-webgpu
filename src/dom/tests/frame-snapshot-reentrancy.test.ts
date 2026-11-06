import { afterEach, expect, it } from 'vitest'
import { captureSubmission } from '../../core/frame-observers.js'
import { attachCanvasImage, observeDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { FrameObserver } from '../../render/shared/frame-observer.js'
import { TerminalSession } from '../../term/session.js'
import { CanvasImageRelay } from '../canvas-image.js'
import { CapturedSubmission } from '../submitted-frame.js'
import { LocalTerminalExecution } from '../execution-local.js'
import { calculateTerminalFittedFont } from '../fit.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

type Snapshot = Parameters<LocalTerminalExecution['submit']>[0]

async function createTerminal(
  bidi: boolean,
  retainDisplayedText: boolean,
  rowRenderer = false,
  worker = false,
) {
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
  const publish = (snapshot: Snapshot) => {
    execution.submit(snapshot)
    publications += 1
  }
  const makeObserver = () => {
    const next = new FrameObserver({
      rows: 4,
      [attachCanvasImage]: () => relay.attach(),
      [captureSubmission]: () => execution.sampleSubmission(),
      ...(worker ? { onTextFrame: publish } : { [observeDisplayedFrame]: publish }),
      needsFrameRows: () => rowRenderer || worker,
      retainDisplayedText,
    })
    cleanups.push(() => next.dispose())
    next.activateCanvasImage()
    return next
  }
  const observer = makeObserver()
  const selection = session.on('selection', () => observer.invalidate())
  const scroll = session.on('scroll', () => {
    if (rowRenderer) observer.invalidate()
  })
  const resize = session.on('resize', ({ grid }) => observer.resize(grid.rows))
  cleanups.push(() => {
    selection.dispose()
    scroll.dispose()
    resize.dispose()
  })
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
    observer,
    makeObserver,
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

    const seen: ReturnType<LocalTerminalExecution['frameSnapshot']>[] = []
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
    const read = seen[0]
    expect(read).toBeDefined()
    expect(rowText(read!.rows)).toEqual(['one', '', '', ''])
    if (readFirst && damaged) expect(read).toBe(first)
  },
)

it('reads frameSnapshot from a canvas-image listener without native retention', async () => {
  const terminal = await createTerminal(false, false)
  const { execution, state } = terminal
  execution.write('\x1b[?25lone')
  state.update()
  terminal.capture().notify('drawn')
  const seen: ReturnType<LocalTerminalExecution['frameSnapshot']>[] = []
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
    const capturedRevision = execution.revision
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
    expect(execution.frameSnapshot()).toBeUndefined()
    expect(execution.captureViewport(800, 400)).toBeUndefined()
    expect(execution.selectionIdentity?.revision).toBe(capturedRevision)
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
  expect.soft(execution.submittedFrame?.scrollbar).toEqual({ length: 4, offset: 0, total: 4 })
  expect(execution.captureViewport(800, 400)).toBeUndefined()
  expect(execution.linkProjection).toBeUndefined()
  expect(rowText(execution.frameSnapshot()?.rows)).toEqual(['one', 'two', '', ''])
})

it.each([false, true])(
  'drops a selection publication without expanding non-retained availability, cached %s',
  async (cached) => {
    const terminal = await createTerminal(true, true)
    const { execution, state } = terminal
    execution.write('\x1b[?25lone two')
    state.update()
    terminal.capture().notify('drawn')
    const submitted = execution.submittedFrame
    const first = cached ? execution.frameSnapshot() : undefined
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
    expect(execution.frameSnapshot()).toBe(first)
    expect(rowText(execution.textFrame()?.rows)).toEqual(['one two', '', '', ''])
  },
)

async function publishedOne() {
  const f = await createTerminal(false, true)
  f.execution.write('\x1b[?25lone')
  f.state.update()
  f.capture().notify('drawn')
  return f
}

it('reads lazy submitted text during a retained image listener', async () => {
  const f = await publishedOne()
  const seen: (string[] | undefined)[] = []
  f.relay.subscribe(() => seen.push(rowText(f.execution.textFrame()?.rows)))
  f.execution.write('\r\ntwo')
  f.state.update()
  f.capture().notify('drawn')
  expect(f.reported).toEqual([])
  expect(seen).toEqual([['one', '', '', '']])
})

it('keeps A readable between coordinated acceptance and notification', async () => {
  const f = await publishedOne()
  f.execution.write('\r\ntwo')
  f.state.update()
  const frame = f.capture()
  expect(rowText(f.execution.frameSnapshot()?.rows)).toEqual(['one', '', '', ''])
  expect(rowText(f.execution.textFrame()?.rows)).toEqual(['one', '', '', ''])
  frame.notify('drawn')
  expect(f.publications).toBe(2)
  expect(rowText(f.execution.textFrame()?.rows)).toEqual(['one', 'two', '', ''])
})

it.each(['snapshot', 'text', 'patches'])(
  'keeps published history after a drop for %s',
  async (read) => {
    const f = await publishedOne()
    f.execution.write('\r\ntwo')
    f.execution.selectRange({ x: 0, y: 0 }, { x: 1, y: 0 })
    f.state.update()
    const frame = f.capture()
    const subscription = f.relay.subscribe(() => f.execution.clearSelection())
    frame.notify('drawn')
    if (subscription.kind === 'subscription') subscription.dispose()
    expect(f.publications).toBe(1)
    if (read === 'snapshot')
      expect(rowText(f.execution.frameSnapshot()?.rows)).toEqual(['one', '', '', ''])
    if (read === 'text') expect(rowText(f.execution.textFrame()?.rows)).toEqual(['one', '', '', ''])
    f.state.update()
    f.capture().notify('drawn')
    expect(rowText(f.execution.frameSnapshot()?.rows)).toEqual(['one', 'two', '', ''])
    expect(
      f.execution.submittedFrame?.rowPatches.map((row) => ({ y: row.y, text: row.text.trimEnd() })),
    ).toContainEqual({ y: 1, text: 'two' })
    expect(f.reported).toEqual([])
  },
)

it('settles a nested retained publication without discarding its successor', async () => {
  const f = await publishedOne()
  let nested = false
  f.relay.subscribe(() => {
    if (nested) return
    nested = true
    f.capture().notify('drawn')
  })
  f.execution.write('\r\ntwo')
  f.state.update()
  f.capture().notify('drawn')
  expect(f.reported).toEqual([])
  expect(f.publications).toBe(2)
  expect(rowText(f.execution.frameSnapshot()?.rows)).toEqual(['one', 'two', '', ''])
})

it('settles disposal before a replacement observer captures', async () => {
  const f = await publishedOne()
  f.execution.write('\r\ntwo')
  f.state.update()
  f.capture()
  f.observer.dispose()
  const replacement = f.makeObserver()
  expect(() =>
    replacement.emit(f.state, f.state.readCursor(), undefined, [0, 1, 2, 3]),
  ).not.toThrow()
  expect(f.publications).toBe(2)
})

it('keeps unread A readable after accepted B is disposed without publication', async () => {
  const f = await publishedOne()
  f.execution.write('\r\ntwo')
  f.state.update()
  f.capture()
  f.observer.dispose()
  expect(rowText(f.execution.frameSnapshot()?.rows)).toEqual(['one', '', '', ''])
  expect(rowText(f.execution.textFrame()?.rows)).toEqual(['one', '', '', ''])
})

it('keeps undamaged non-retained A available during its listener', async () => {
  const f = await createTerminal(false, false)
  f.execution.write('\x1b[?25lone')
  f.state.update()
  f.capture().notify('drawn')
  const seen: (string[] | undefined)[] = []
  f.relay.subscribe(() => seen.push(rowText(f.execution.frameSnapshot()?.rows)))
  f.state.update()
  f.capture().notify('drawn')
  expect(f.reported).toEqual([])
  expect(seen).toEqual([['one', '', '', '']])
})

it('captures the bottom scrollbar before a GPU listener scrolls', async () => {
  const f = await createTerminal(false, true)
  f.execution.write('\x1b[?25l1\r\n2\r\n3\r\n4\r\n5\r\n6')
  f.state.update()
  expect(f.execution.scrollbar).toEqual({ length: 4, offset: 2, total: 6 })
  const frame = f.capture()
  f.relay.subscribe(() => f.execution.scrollBy(-1))
  frame.notify('drawn')
  expect(f.publications).toBe(1)
  expect(f.execution.scrollbar.offset).toBe(1)
  expect(f.execution.submittedFrame?.scrollbar).toEqual({ length: 4, offset: 2, total: 6 })
})

it('captures row-renderer metadata before a listener writes without scrolling', async () => {
  const f = await createTerminal(false, false, true)
  f.execution.write('\x1b[?25lone')
  f.state.update()
  const revision = f.execution.revision
  const frame = f.capture()
  f.relay.subscribe(() => f.execution.write('X'))
  frame.notify('drawn')
  expect(f.publications).toBe(1)
  expect(f.reported).toEqual([])
  expect(f.execution.submittedFrame?.nativeRevision).toBe(revision)
  expect(f.execution.submittedFrame?.scrollbar).toEqual({ length: 4, offset: 0, total: 4 })
  expect(rowText(f.execution.textFrame()?.rows)).toEqual(['one', '', '', ''])
})

it('clones only the literal public worker text-frame schema', async () => {
  const f = await createTerminal(false, false, true, true)
  f.execution.write('\x1b[?25lone')
  f.state.update()
  f.capture().notify('drawn')
  const clone = structuredClone(f.execution.textFrame()!)
  expect(Object.getOwnPropertySymbols(clone)).toEqual([])
  expect(Object.keys(clone).sort()).toEqual(['cursor', 'paintedCursor', 'renderHeld', 'rows'])
})

it('keeps the effective grid-bump layout through resubmission', async () => {
  const f = await publishedOne()
  const layouts = [f.execution.submittedFrame!.layout]
  f.execution.resize({ columns: 12 })
  f.state.update()
  f.capture().notify('drawn')
  layouts.push(f.execution.submittedFrame!.layout)
  expect(f.execution.submittedFrame!.rowPatches).toHaveLength(4)
  expect(f.execution.submittedFrame!.grid.columns).toBe(12)
  f.execution.submit(f.execution.textFrame()!)
  layouts.push(f.execution.submittedFrame!.layout)
  expect(layouts).toEqual([1, 2, 2])
  expect(f.execution.captureViewport(800, 400)).toEqual(expect.any(String))
  expect(f.execution.linkProjection?.layout).toBe(2)
})

it('captures the held revision before a listener writes', async () => {
  const f = await publishedOne()
  f.execution.write('\x1b[?2026h')
  f.state.update()
  const revision = f.execution.revision
  const frame = f.capture()
  f.relay.subscribe(() => f.execution.write('pending'))
  frame.notify('drawn')
  expect(f.execution.textFrame()?.renderHeld).toBe(true)
  expect(f.execution.submittedFrame?.nativeRevision).toBe(revision)
  expect(f.execution.captureViewport(800, 400)).toBeUndefined()
})

it('keeps the submitted old grid after a listener resize drops B', async () => {
  const f = await publishedOne()
  f.execution.write('\r\ntwo')
  f.state.update()
  const frame = f.capture()
  const subscription = f.relay.subscribe(() => f.execution.resize({ columns: 12 }))
  frame.notify('drawn')
  if (subscription.kind === 'subscription') subscription.dispose()
  expect(f.publications).toBe(1)
  expect(f.execution.frameSnapshot()?.rows[0]?.cells).toHaveLength(20)
  f.state.update()
  f.capture().notify('drawn')
  expect(f.execution.frameSnapshot()?.rows[0]?.cells).toHaveLength(12)
  expect(f.execution.submittedFrame?.rowPatches).toHaveLength(4)
})

it('does not roll back a native publication after its installed submission callback throws', async () => {
  const f = await publishedOne()
  const old = f.execution.textFrame()!
  let fail = true
  const observer = new FrameObserver({
    rows: 4,
    retainDisplayedText: true,
    needsFrameRows: () => false,
    [captureSubmission]: () => f.execution.sampleSubmission(),
    [observeDisplayedFrame]: (snapshot) => {
      f.execution.submit(snapshot)
      if (!fail) return
      fail = false
      throw new Error('after installation')
    },
  })
  cleanups.push(() => observer.dispose())
  f.execution.write('\r\ntwo')
  f.state.update()
  expect(() => observer.emit(f.state, f.state.readCursor(), undefined, [1])).toThrow(
    'after installation',
  )
  expect(() => old.rows).toThrow('retired')
  expect(rowText(f.execution.frameSnapshot()?.rows)).toEqual(['one', 'two', '', ''])
  f.execution.write('\r\nthree')
  f.state.update()
  expect(() => observer.emit(f.state, f.state.readCursor(), undefined, [2])).not.toThrow()
  expect(rowText(f.execution.frameSnapshot()?.rows)).toEqual(['one', 'two', 'three', ''])
})

it('does not replace a captured layout with a newer unrelated host layout', async () => {
  const f = await publishedOne()
  f.execution.write('\r\ntwo')
  f.state.update()
  const frame = f.capture()
  f.execution.commitLayout(
    calculateTerminalFittedFont(
      f.session.appearance.font,
      { advanceWidth: 9, fontAscent: 11, fontDescent: 3 },
      1,
    ),
    { top: 0, right: 0, bottom: 0, left: 0 },
  )
  frame.notify('drawn')
  expect(f.execution.submittedFrame!.layout).toBe(1)
  expect(f.execution.captureViewport(800, 400)).toBeUndefined()
  expect(f.execution.linkProjection).toBeUndefined()
})

it('owns and deeply freezes fresh captured selection coordinates without copying them', async () => {
  const f = await publishedOne()
  f.execution.selectRange({ x: 0, y: 0 }, { x: 2, y: 0 })
  const coordinates = f.session.selectionCoordinates()!
  const before = f.execution.sampleSubmission()
  const captured = new CapturedSubmission({ ...before, selection: coordinates })
  expect(captured.selection).toBe(coordinates)
  expect(Object.isFrozen(captured)).toBe(true)
  expect(Object.isFrozen(coordinates)).toBe(true)
  expect(Object.isFrozen(coordinates.start)).toBe(true)
  expect(Object.isFrozen(coordinates.end)).toBe(true)
  const refreshed = captured.withRevision(captured.nativeRevision + 1)
  expect(refreshed.selection).toBe(coordinates)
  expect(refreshed.snapshotVersion).toBe(captured.snapshotVersion)
  expect(refreshed.layout).toBe(captured.layout)
  expect(captured.nativeRevision).toBe(before.nativeRevision)
})

it('fully recaptures acknowledged rows after a publication-only invalidation', async () => {
  const f = await publishedOne()
  f.execution.write('\r\ntwo')
  f.state.update()
  const frame = f.capture()
  const subscription = f.relay.subscribe(() => f.observer.invalidate())
  frame.notify('drawn')
  if (subscription.kind === 'subscription') subscription.dispose()
  expect(f.publications).toBe(1)
  f.state.update()
  f.capture().notify('drawn')
  expect(rowText(f.execution.frameSnapshot()?.rows)).toEqual(['one', 'two', '', ''])
  expect(
    f.execution.submittedFrame!.rowPatches.map((row) => ({ y: row.y, text: row.text.trimEnd() })),
  ).toContainEqual({ y: 1, text: 'two' })
})
