import type { SelectionCoordinates } from '../core/selection.js'
import type { TerminalScrollbar } from '../core/types.js'
import type { RendererTextFrameSnapshot } from '../render/renderer.js'
import type { TerminalFittedFont, TerminalGrid, TerminalRendererTheme } from '../term/types.js'
import type { TerminalElementPadding } from './elements.js'

export interface TerminalSubmittedRow {
  readonly y: number
  readonly text: string
}

/** Displayed state from one submission; authoritative queries still belong to execution. */
export interface TerminalSubmittedFrame {
  readonly frame: number
  readonly nativeRevision: number
  readonly snapshotVersion: number | undefined
  readonly layout: number
  readonly grid: TerminalGrid
  readonly font: TerminalFittedFont
  readonly padding: TerminalElementPadding
  readonly theme: TerminalRendererTheme
  readonly cursor: RendererTextFrameSnapshot['cursor']
  readonly paintedCursor: RendererTextFrameSnapshot['paintedCursor']
  readonly selection:
    | { readonly [Key in keyof SelectionCoordinates]: Readonly<SelectionCoordinates[Key]> }
    | undefined
  readonly scrollbar: Readonly<TerminalScrollbar>
}

export interface TerminalSubmittedText {
  readonly frame: number
  readonly rows: readonly TerminalSubmittedRow[]
  readonly rowPatches: readonly TerminalSubmittedRow[]
}

/** Internal renderer publication; GPU row access materializes retained native text. */
export interface TerminalSubmittedSnapshot extends TerminalSubmittedFrame, TerminalSubmittedText {}

export interface TerminalSubmission {
  readonly nativeRevision: number
  readonly snapshotVersion: number | undefined
  readonly layout: number
  readonly grid: TerminalGrid
  readonly font: TerminalFittedFont
  readonly padding: TerminalElementPadding
  readonly theme: TerminalRendererTheme
  readonly selection: Readonly<SelectionCoordinates> | undefined
  readonly scrollbar: Readonly<TerminalScrollbar>
  readonly snapshot: RendererTextFrameSnapshot
  readonly previousTextRows?: () => readonly TerminalSubmittedRow[]
}

export function submittedFrame(
  previous: TerminalSubmittedSnapshot | undefined,
  input: TerminalSubmission,
): TerminalSubmittedSnapshot {
  if (input.previousTextRows) return retainedSubmittedFrame(previous, input)
  const rowPatches: TerminalSubmittedRow[] = []
  const sameLayout = previous?.layout === input.layout
  const previousRows = sameLayout ? previous.rows : []
  const rows = input.snapshot.rows.map((row) => {
    const old = previousRows[row.y]
    if (old?.y === row.y && old.text === row.text) return old
    const owned = Object.freeze({ y: row.y, text: row.text })
    rowPatches.push(owned)
    return owned
  })
  const viewport = input.snapshot.cursor.viewport
  return Object.freeze({
    frame: (previous?.frame ?? 0) + 1,
    nativeRevision: input.nativeRevision,
    snapshotVersion: input.snapshotVersion,
    layout: input.layout,
    grid: Object.freeze({ ...input.grid }),
    font: input.font,
    padding: Object.freeze({ ...input.padding }),
    theme: input.theme,
    cursor: Object.freeze({
      ...input.snapshot.cursor,
      viewport: viewport ? Object.freeze({ ...viewport }) : undefined,
    }),
    paintedCursor: input.snapshot.paintedCursor
      ? Object.freeze({ ...input.snapshot.paintedCursor })
      : undefined,
    selection: input.selection
      ? Object.freeze({
          ...input.selection,
          start: Object.freeze({ ...input.selection.start }),
          end: Object.freeze({ ...input.selection.end }),
        })
      : undefined,
    scrollbar: Object.freeze({ ...input.scrollbar }),
    rows: Object.freeze(rows),
    rowPatches: Object.freeze(rowPatches),
  })
}

function retainedSubmittedFrame(
  previous: TerminalSubmittedSnapshot | undefined,
  input: TerminalSubmission,
): TerminalSubmittedSnapshot {
  const sameLayout = previous?.layout === input.layout
  const eagerPreviousRows = sameLayout && !input.previousTextRows ? previous.rows : []
  let rows: readonly TerminalSubmittedRow[] | undefined
  let rowPatches: readonly TerminalSubmittedRow[] | undefined
  const materialize = () => {
    if (rows) return
    const patches: TerminalSubmittedRow[] = []
    const previousRows = sameLayout ? (input.previousTextRows?.() ?? eagerPreviousRows) : []
    rows = Object.freeze(
      input.snapshot.rows.map((row) => {
        const old = previousRows[row.y]
        if (old?.y === row.y && old.text === row.text) return old
        const owned = Object.freeze({ y: row.y, text: row.text })
        patches.push(owned)
        return owned
      }),
    )
    rowPatches = Object.freeze(patches)
  }
  if (!input.previousTextRows) materialize()
  const viewport = input.snapshot.cursor.viewport
  return Object.freeze({
    frame: (previous?.frame ?? 0) + 1,
    nativeRevision: input.nativeRevision,
    snapshotVersion: input.snapshotVersion,
    layout: input.layout,
    grid: Object.freeze({ ...input.grid }),
    font: input.font,
    padding: Object.freeze({ ...input.padding }),
    theme: input.theme,
    cursor: Object.freeze({
      ...input.snapshot.cursor,
      viewport: viewport ? Object.freeze({ ...viewport }) : undefined,
    }),
    paintedCursor: input.snapshot.paintedCursor
      ? Object.freeze({ ...input.snapshot.paintedCursor })
      : undefined,
    selection: input.selection
      ? Object.freeze({
          ...input.selection,
          start: Object.freeze({ ...input.selection.start }),
          end: Object.freeze({ ...input.selection.end }),
        })
      : undefined,
    scrollbar: Object.freeze({ ...input.scrollbar }),
    get rows() {
      materialize()
      return rows!
    },
    get rowPatches() {
      materialize()
      return rowPatches!
    },
  })
}
