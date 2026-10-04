import type { TerminalSession } from '../term/session.js'
import type { SelectionIdentity } from '../term/selection-history.js'
import type { TerminalSubmittedFrame } from './submitted-frame.js'
import { encodeTerminalViewport } from './viewport.js'

export interface SelectionHistoryCaptureSource {
  readonly identity: SelectionIdentity
  readonly summary: TerminalSubmittedFrame
}

export function captureSelectionHistoryViewport(
  session: TerminalSession<Event>,
  source: SelectionHistoryCaptureSource | undefined,
  current: Omit<SelectionIdentity, 'revision'>,
  width: number,
  height: number,
): string | undefined {
  if (!source) return undefined
  const { identity, summary } = source
  if (
    identity.generation !== current.generation ||
    identity.layout !== current.layout ||
    identity.revision !== session.revision ||
    summary.nativeRevision !== identity.revision ||
    summary.layout !== identity.layout ||
    summary.snapshotVersion !== session.renderState.snapshotVersion
  )
    return undefined
  const painted = summary.paintedCursor
  const cursor = painted
    ? {
        ...summary.cursor,
        visible: painted.visible,
        style: painted.style,
        viewport: { x: painted.x, y: painted.y, wideTail: false },
      }
    : summary.cursor
  return encodeTerminalViewport({
    width,
    height,
    columns: summary.grid.columns,
    rows: session.renderState.readRows(),
    cursor,
    scrollbar: summary.scrollbar,
    font: summary.font,
    theme: summary.theme,
    padding: summary.padding,
  })
}
