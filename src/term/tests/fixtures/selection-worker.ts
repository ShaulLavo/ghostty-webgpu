import { LocalTerminalExecution } from '../../../dom/execution-local.js'
import { calculateTerminalFittedFont } from '../../../dom/fit.js'
import { captureSelectionHistoryViewport } from '../../../dom/history-capture.js'
import { TerminalSession } from '../../session.js'
import {
  NativeSelectionHistory,
  type TerminalHistorySnapshot,
  type TerminalSelectionSnapshot,
} from '../../selection-history.js'

export type SelectionFixtureCommand =
  | 'start'
  | 'read'
  | 'clear'
  | 'scroll'
  | 'range'
  | 'all'
  | 'dispose'
export interface SelectionFixtureReply {
  readonly selection: TerminalSelectionSnapshot
  readonly history: TerminalHistorySnapshot
  readonly topOffset: number
  readonly text: string | undefined
  readonly capture: string | undefined
}

let session: TerminalSession<Event> | undefined
let requests: NativeSelectionHistory | undefined
let execution: LocalTerminalExecution | undefined

async function handle(
  command: SelectionFixtureCommand,
): Promise<SelectionFixtureReply | undefined> {
  if (command === 'start') {
    session = await TerminalSession.create<Event>({ appearance: { grid: { columns: 8, rows: 3 } } })
    execution = new LocalTerminalExecution(session)
    const font = calculateTerminalFittedFont(
      session.appearance.font,
      { advanceWidth: 10, fontAscent: 16, fontDescent: 4 },
      1,
    )
    execution.commitLayout(font, { bottom: 0, left: 3, right: 0, top: 4 })
    requests = new NativeSelectionHistory(session, () => ({
      generation: 1,
      layout: execution?.submittedFrame?.layout ?? 1,
    }))
    session.write('one\r\ntwo\r\nthree\r\nfour')
    requests.selectLines(0, 1)
  }
  if (!session || !requests || !execution)
    throw new TypeError('The native worker fixture has not started')
  if (command === 'dispose') {
    execution.dispose()
    return undefined
  }
  if (command === 'clear') requests.clearSelection()
  if (command === 'scroll') {
    requests.scrollToTop()
    requests.scrollBy(1)
    requests.scrollToBottom()
    requests.scrollToRow(0)
  }
  if (command === 'range') requests.selectRange({ x: 0, y: 0 }, { x: 2, y: 0 })
  if (command === 'all') requests.selectAll()
  const topOffset = session.scrollbar.offset
  session.renderState.update()
  execution.submit({ cursor: session.renderState.readCursor(), rows: [] })
  const summary = execution.submittedFrame
  const capture = summary
    ? captureSelectionHistoryViewport(
        session,
        {
          identity: { generation: 1, layout: summary.layout, revision: summary.nativeRevision },
          summary,
        },
        { generation: 1, layout: summary.layout },
        800,
        400,
      )
    : undefined
  const result = {
    selection: requests.selectionSnapshot(),
    history: requests.historySnapshot(0, requests.lineCount()),
    topOffset,
    text: requests.getSelection(),
    capture,
  }
  if (command === 'read') await new Promise<void>((resolve) => setTimeout(resolve, 30))
  return result
}

let ordered = Promise.resolve()
self.addEventListener('message', (event: MessageEvent<SelectionFixtureCommand>) => {
  ordered = ordered.then(async () => {
    try {
      self.postMessage({ result: await handle(event.data) })
    } catch (cause) {
      self.postMessage({ failure: String(cause) })
    }
  })
})
