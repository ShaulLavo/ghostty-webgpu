import { afterEach, describe, expect, it } from 'vitest'
import { TerminalSession } from '../session.js'
import {
  assertSelectionIdentity,
  NativeSelectionHistory,
  ownedSelectionCoordinates,
} from '../selection-history.js'

const sessions: TerminalSession<Event>[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
})
async function native(context = () => ({ generation: 1, layout: 2 })) {
  const session = await TerminalSession.create<Event>({
    appearance: { grid: { columns: 8, rows: 3 } },
  })
  sessions.push(session)
  const requests = new NativeSelectionHistory(session, context)
  return { session, requests }
}

describe('native selection and history requests', () => {
  it('supports await-style reads and mutations while main results remain synchronous', async () => {
    const { session, requests } = await native()
    session.write('one\r\ntwo\r\nthree\r\nfour')
    expect(requests.lineCount()).toBe(4)
    expect(await requests.selectLines(0, 1)).toBe(true)
    const selected = await requests.selectionSnapshot()
    expect(selected).toMatchObject({
      generation: 1,
      layout: 2,
      revision: session.revision,
      selection: { text: 'one\ntwo', coordinates: { rectangle: false } },
    })
    expect(await requests.getSelection()).toBe(selected.selection?.text)
    expect(await requests.selectionCoordinates()).toEqual(selected.selection?.coordinates)
    expect(await requests.clearSelection()).toBe(true)
    expect(await requests.selectionSnapshot()).toEqual({
      generation: 1,
      layout: 2,
      revision: session.revision,
      selection: undefined,
    })
    expect(await requests.selectRange({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(true)
    expect(await requests.getSelection()).toBe('one')
    expect(await requests.selectAll()).toBe(true)
    expect(await requests.getSelection()).toBe('one\ntwo\nthree\nfour')
  })

  it('owns nested selection and history values through later native writes, scrolls and disposal', async () => {
    const { session, requests } = await native()
    session.write('one\r\ntwo\r\nthree\r\nfour')
    requests.selectLines(0, 1)
    const selection = requests.selectionSnapshot()
    const history = requests.historySnapshot(0, 10)
    const savedSelection = structuredClone(selection)
    const savedHistory = structuredClone(history)
    const revision = session.revision
    expect(await requests.scrollToTop()).toMatchObject({ revision: revision + 1 })
    expect(await requests.scrollBy(1)).toMatchObject({ revision: session.revision })
    await requests.scrollToRow(0)
    await requests.scrollToBottom()
    session.write('\r\nreplacement')
    session.dispose()
    expect(selection).toEqual(savedSelection)
    expect(history).toEqual(savedHistory)
    expect(Object.isFrozen(selection.selection?.coordinates.start)).toBe(true)
    expect(Object.isFrozen(history.lines[0])).toBe(true)
  })

  it('rejects mixed native revisions and changed generation/layout during atomic read', async () => {
    let change = () => {}
    let calls = 0
    const { session, requests } = await native(() => {
      if (++calls % 2 === 0) change()
      return { generation: 1, layout: 2 }
    })
    session.write('hello')
    requests.selectAll()
    change = () => {
      session.clearSelection()
    }
    expect(() => requests.selectionSnapshot()).toThrow('identity changed')
    let generation = 0
    const stale = new NativeSelectionHistory(session, () => ({
      generation: ++generation,
      layout: 2,
    }))
    expect(() => stale.historySnapshot(0, 1)).toThrow('identity changed')
    let layout = 0
    const changed = new NativeSelectionHistory(session, () => ({ generation: 1, layout: ++layout }))
    expect(() => changed.selectionSnapshot()).toThrow('identity changed')
  })

  it('rejects old projected geometry before native selection mutations', async () => {
    const { session, requests } = await native()
    session.write('hello')
    const actual = { generation: 1, layout: 2, revision: session.revision }
    const input = {
      position: { x: 10, y: 20 },
      repeatDistance: 10,
      repeatIntervalNanoseconds: 500_000_000n,
      timeNanoseconds: 1_000_000_000n,
      viewport: { x: 1, y: 1 },
    }
    for (const expected of [
      { ...actual, generation: 0 },
      { ...actual, layout: 1 },
      { ...actual, revision: 0 },
    ]) {
      expect(() => requests.selectionPress(input, expected)).toThrow('identity changed')
      expect(session.revision).toBe(actual.revision)
    }
    expect(() => requests.selectionPress(input, actual)).not.toThrow()
    expect(() => assertSelectionIdentity(actual, { ...actual, layout: 3 })).toThrow(
      'identity changed',
    )
  })

  it('accepts queued own selection revisions and fences external output and a new gesture', async () => {
    const { session, requests } = await native()
    session.write('abcdefgh')
    const identity = requests.selectionSnapshot()
    const press = {
      position: { x: 0, y: 0 },
      viewport: { x: 0, y: 0 },
      repeatDistance: 10,
      repeatIntervalNanoseconds: 500_000_000n,
      timeNanoseconds: 1n,
    }
    const drag = {
      geometry: { cellWidth: 10, columns: 8, paddingLeft: 0, screenHeight: 60 },
      position: { x: 20, y: 0 },
      viewport: { x: 2, y: 0 },
    }
    requests.selectionPress(press, identity)
    requests.selectionDrag(drag, identity)
    requests.selectionDrag(
      { ...drag, position: { x: 40, y: 0 }, viewport: { x: 4, y: 0 } },
      identity,
    )
    expect(requests.selectionRelease(drag.viewport, identity).dragged).toBe(true)
    expect(requests.getSelection()).toContain('abcd')
    expect(() => requests.selectionPress(press, identity)).toThrow('identity changed')
    const newer = requests.selectionSnapshot()
    requests.selectionPress({ ...press, timeNanoseconds: 1_000_000_000n }, newer)
    requests.selectionDrag(drag, newer)
    session.write('external')
    expect(() => requests.selectionDrag(drag, newer)).toThrow('identity changed')
    expect(() => requests.selectionRelease(drag.viewport, newer)).toThrow('identity changed')
  })

  it('invalidates a gesture projection when a selection observer writes reentrantly', async () => {
    const { session, requests } = await native()
    session.write('abcdefgh')
    const identity = requests.selectionSnapshot()
    const press = {
      position: { x: 0, y: 0 },
      viewport: { x: 0, y: 0 },
      repeatDistance: 10,
      repeatIntervalNanoseconds: 500_000_000n,
      timeNanoseconds: 1n,
    }
    const drag = {
      geometry: { cellWidth: 10, columns: 8, paddingLeft: 0, screenHeight: 60 },
      position: { x: 20, y: 0 },
      viewport: { x: 2, y: 0 },
    }
    requests.selectionPress(press, identity)
    session.on('selection', () => session.write('external'))
    requests.selectionDrag(drag, identity)
    expect(() => requests.selectionRelease(drag.viewport, identity)).toThrow('identity changed')
  })

  it('copies borrowed coordinates before their owner changes them', () => {
    const borrowed = { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, rectangle: false }
    const owned = ownedSelectionCoordinates(borrowed)
    borrowed.start.x = 99
    borrowed.end.y = 99
    expect(owned).toEqual({ start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, rectangle: false })
  })
})
