import { afterEach, describe, expect, it } from 'vitest'
import { TerminalSession } from '../../term/session.js'
import { LocalTerminalExecution } from '../execution-local.js'
import { calculateTerminalFittedFont } from '../fit.js'
import { captureSelectionHistoryViewport } from '../history-capture.js'

const executions: LocalTerminalExecution[] = []
afterEach(() => {
  for (const execution of executions.splice(0)) execution.dispose()
})

async function submitted() {
  const session = await TerminalSession.create<Event>({
    appearance: { grid: { columns: 8, rows: 3 } },
  })
  const execution = new LocalTerminalExecution(session)
  executions.push(execution)
  const font = calculateTerminalFittedFont(
    session.appearance.font,
    { advanceWidth: 10, fontAscent: 16, fontDescent: 4 },
    1,
  )
  execution.commitLayout(font, { bottom: 0, left: 3, right: 0, top: 4 })
  session.write('initial')
  session.renderState.update()
  execution.submit({ cursor: session.renderState.readCursor(), rows: [] })
  const summary = execution.submittedFrame
  if (!summary) throw new TypeError('Native fixture did not submit')
  const identity = { generation: 1, layout: summary.layout, revision: summary.nativeRevision }
  return {
    session,
    execution,
    source: { identity, summary },
    current: { generation: 1, layout: summary.layout },
  }
}

describe('on-demand selection/history viewport capture', () => {
  it('returns an owned capture matching the committed native revision and layout', async () => {
    const { session, execution, source, current } = await submitted()
    const capture = await captureSelectionHistoryViewport(session, source, current, 800, 400)
    expect(capture).toEqual(execution.captureViewport(800, 400))
    expect(capture).toContain('"version":1')
    const saved = capture
    session.write('\rchanged')
    session.renderState.update()
    expect(captureSelectionHistoryViewport(session, source, current, 800, 400)).toBeUndefined()
    expect(capture).toBe(saved)
  })

  it('holds captures for changed generation, layout or native snapshot', async () => {
    const { session, source, current } = await submitted()
    expect(captureSelectionHistoryViewport(session, undefined, current, 800, 400)).toBeUndefined()
    expect(
      captureSelectionHistoryViewport(session, source, { ...current, generation: 2 }, 800, 400),
    ).toBeUndefined()
    expect(
      captureSelectionHistoryViewport(
        session,
        source,
        { ...current, layout: current.layout + 1 },
        800,
        400,
      ),
    ).toBeUndefined()
    expect(
      captureSelectionHistoryViewport(
        session,
        { ...source, summary: { ...source.summary, nativeRevision: 0 } },
        current,
        800,
        400,
      ),
    ).toBeUndefined()
    session.renderState.update()
    expect(
      captureSelectionHistoryViewport(
        session,
        { ...source, summary: { ...source.summary, snapshotVersion: 0 } },
        current,
        800,
        400,
      ),
    ).toBeUndefined()
  })
})
