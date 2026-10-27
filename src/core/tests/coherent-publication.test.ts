import { afterEach, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import { FrameObserver } from '../../render/shared/frame-observer.js'
import {
  observeDisplayedFrame,
  type DisplayedTextFrame,
} from '../../render/shared/displayed-frame.js'
import { submittedFrame, type TerminalSubmittedSnapshot } from '../../dom/submitted-frame.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

const json = (value: unknown) => JSON.stringify(value)

function submit(previous: TerminalSubmittedSnapshot | undefined, snapshot: DisplayedTextFrame) {
  const nativeFrame = snapshot.nativeFrame
  return submittedFrame(previous, {
    nativeRevision: 0,
    snapshotVersion: 0,
    layout: 1,
    grid: {} as never,
    font: {} as never,
    padding: {} as never,
    theme: {} as never,
    selection: undefined,
    scrollbar: {} as never,
    snapshot,
    previousTextRows: nativeFrame
      ? () =>
          (snapshot.previousTextRows ?? nativeFrame.readPreviousTextRows()).map((row) =>
            Object.freeze({ y: row.y, text: row.text }),
          )
      : undefined,
  })
}

const outputs: readonly ((frame: number) => string)[] = [
  (frame) => `\x1b[H\x1b[2Jdense ${frame}\r\n` + `row ${frame} `.repeat(6),
  (frame) => `\r\nscroll ${frame} 界 é 🧑‍💻 ☕️`,
  (frame) => `\x1b[3;1H\x1b[2K\x1b[1;38;2;1;2;3mstyled ${frame % 2}\x1b[0m`,
  () => '',
  (frame) => `\x1b[${(frame % 4) + 1};5H${frame % 3 === 0 ? ' ' : 'x'}`,
]

describe('text derived from the retained displayed frame', () => {
  it.each(['on', 'off'])('matches live text with observers %s', async (mode) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 5 })
    const state = runtime.createRenderState(terminal)
    let summary: TerminalSubmittedSnapshot | undefined
    let expectedSummary: TerminalSubmittedSnapshot | undefined
    let previousLive: string | undefined
    let observed: DisplayedTextFrame | undefined
    const observer = new FrameObserver({
      columns: 24,
      rows: 5,
      retainDisplayedText: true,
      needsFrameRows: () => mode === 'on',
      [observeDisplayedFrame]: (snapshot: DisplayedTextFrame) => {
        observed = snapshot
      },
    } as never)
    for (let frame = 0; frame < 40; frame += 1) {
      terminal.write(outputs[frame % outputs.length]!(frame))
      if (frame === 23) {
        terminal.resize({ columns: 30, rows: 6 } as never)
        observer.resize(6)
      }
      state.update()
      const live = state.readTextRows()
      const prepared = observer.capture(state, state.readCursor(), undefined, [])
      state.acknowledge()
      prepared.accept()
      prepared.notify()
      const snapshot = observed!
      expect(json(snapshot.rows)).toBe(json(live))
      if (previousLive && frame !== 24)
        expect(json(snapshot.nativeFrame!.readPreviousTextRows())).toBe(previousLive)
      summary = submit(frame === 24 ? undefined : summary, snapshot)
      expectedSummary = submittedFrame(frame === 24 ? undefined : expectedSummary, {
        ...summary,
        snapshot: Object.freeze({ ...snapshot, rows: live }),
      } as never)
      expect(json(summary.rows)).toBe(json(expectedSummary.rows))
      expect(json(summary.rowPatches)).toBe(json(expectedSummary.rowPatches))
      previousLive = json(live)
    }
    state.dispose()
  })
})
