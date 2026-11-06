import type { RendererTextFrameRow, RendererTextFrameSnapshot } from '../render/shared/types.js'
import { submittedFrame, type TerminalSubmittedSnapshot } from '../dom/submitted-frame.js'
import type { WorkerMessage, WorkerRevisionRow } from './protocol.js'
import { freezeWorkerValue } from './owned.js'
import { TerminalWorkerError, workerError } from './structured-errors.js'

type FrameMessage = Extract<WorkerMessage, { type: 'frame' }>
type Identity = Pick<FrameMessage, 'terminal' | 'generation'>
type Pin = ReadonlyMap<number, RendererTextFrameRow>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function finiteFields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
  )
}
function arrayOf<Value>(
  value: unknown,
  valid: (entry: unknown) => entry is Value,
): value is Value[] {
  if (!Array.isArray(value)) return false
  for (const entry of value) if (!valid(entry)) return false
  return true
}
function string(value: unknown): value is string {
  return typeof value === 'string'
}
function boolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}
function revision(value: unknown): value is number {
  return integer(value, 1)
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
function style(value: unknown): boolean {
  return value === 'bar' || value === 'block' || value === 'outline' || value === 'underline'
}
function cursor(value: unknown): boolean {
  if (!record(value) || !style(value.style)) return false
  if (
    typeof value.blinking !== 'boolean' ||
    typeof value.passwordInput !== 'boolean' ||
    typeof value.visible !== 'boolean'
  )
    return false
  return (
    value.viewport === undefined ||
    (finiteFields(value.viewport, ['x', 'y']) && typeof value.viewport.wideTail === 'boolean')
  )
}
function color(value: unknown): boolean {
  return finiteFields(value, ['r', 'g', 'b'])
}
function font(value: unknown): boolean {
  if (
    !finiteFields(value, [
      'charLeft',
      'charTop',
      'cssCellHeight',
      'cssCellWidth',
      'deviceBaseline',
      'deviceCellHeight',
      'deviceCellWidth',
      'deviceCharHeight',
      'deviceCharWidth',
      'pixelRatio',
    ])
  )
    return false
  const settings = value.settings
  if (
    !finiteFields(settings, ['boldWeight', 'letterSpacing', 'lineHeight', 'size', 'weight']) ||
    typeof settings.family !== 'string'
  )
    return false
  return (
    settings.metrics === undefined ||
    finiteFields(settings.metrics, ['unitsPerEm', 'underlineThickness'])
  )
}
function theme(value: unknown): boolean {
  if (!finiteFields(value, ['minimumContrast'])) return false
  return (
    ['background', 'cursor', 'foreground', 'selectionBackground', 'selectionForeground'].every(
      (key) => color(value[key]),
    ) &&
    (value.cursorText === undefined || color(value.cursorText))
  )
}
function submission(value: unknown): value is FrameMessage['submission'] {
  if (!record(value) || !integer(value.nativeRevision) || !integer(value.layout)) return false
  if (value.snapshotVersion !== undefined && !integer(value.snapshotVersion)) return false
  if (
    !finiteFields(value.grid, ['cellHeight', 'cellWidth', 'pixelRatio']) ||
    !integer(value.grid.columns, 1) ||
    !integer(value.grid.rows, 1)
  )
    return false
  if (
    !font(value.font) ||
    !theme(value.theme) ||
    !finiteFields(value.padding, ['top', 'right', 'bottom', 'left'])
  )
    return false
  if (!finiteFields(value.scrollbar, ['length', 'offset', 'total'])) return false
  return (
    value.selection === undefined ||
    (record(value.selection) &&
      typeof value.selection.rectangle === 'boolean' &&
      finiteFields(value.selection.start, ['x', 'y']) &&
      finiteFields(value.selection.end, ['x', 'y']))
  )
}
function snapshot(value: unknown): value is FrameMessage['snapshot'] {
  if (!record(value) || !cursor(value.cursor)) return false
  if (value.renderHeld !== undefined && typeof value.renderHeld !== 'boolean') return false
  return (
    value.paintedCursor === undefined ||
    (finiteFields(value.paintedCursor, ['x', 'y']) &&
      style(value.paintedCursor.style) &&
      typeof value.paintedCursor.visible === 'boolean')
  )
}
function contentRow(value: unknown, columns: number): value is WorkerRevisionRow {
  if (!record(value) || !integer(value.revision, 1) || typeof value.text !== 'string') return false
  if (!arrayOf(value.cells, string) || value.cells.length !== columns) return false
  return arrayOf(value.continuations, boolean) && value.continuations.length === columns
}

/** Parse only at the port boundary. Downstream row readers receive owned, typed values. */
function parseFrame(value: unknown, identity: Identity): FrameMessage {
  if (!record(value) || value.type !== 'frame') throw workerError('protocol', 'frame.shape', {})
  if (value.terminal !== identity.terminal || value.generation !== identity.generation)
    throw workerError('protocol', 'frame.identity', {})
  if (
    !integer(value.frame, 1) ||
    !integer(value.base) ||
    !integer(value.control) ||
    !integer(value.output) ||
    typeof value.mouseTracking !== 'boolean'
  )
    throw workerError('protocol', 'frame.base', {})
  if (!integer(value.store, 1)) throw workerError('protocol', 'frame.store', {})
  if (!submission(value.submission) || !snapshot(value.snapshot))
    throw workerError('protocol', 'frame.metadata', {})
  if (!arrayOf(value.revisions, revision) || value.revisions.length !== value.submission.grid.rows)
    throw workerError('protocol', 'frame.revision', {})
  const columns = value.submission.grid.columns
  if (
    !arrayOf(value.content, (row): row is WorkerRevisionRow => contentRow(row, columns)) ||
    value.content.length > value.revisions.length
  )
    throw workerError('protocol', 'frame.content', {})
  return {
    type: 'frame',
    terminal: identity.terminal,
    generation: identity.generation,
    frame: value.frame,
    base: value.base,
    control: value.control,
    output: value.output,
    mouseTracking: value.mouseTracking,
    store: value.store,
    submission: value.submission,
    snapshot: value.snapshot,
    revisions: value.revisions,
    content: value.content,
  }
}

/** Current lookup pin only. Public summaries and queued clone graphs own their own values. */
export class RevisionReception {
  private store = 0
  private pin: Pin = new Map()
  constructor(readonly identity: Identity) {}
  get size(): number {
    return this.pin.size
  }
  clear(): void {
    this.store = 0
    this.pin = new Map()
  }
  stage(store: number): Pin {
    if (store === this.store && store !== 0) return this.pin
    if (store !== this.store + 1)
      throw workerError('protocol', 'frame.store', { store, previous: this.store })
    return new Map()
  }
  commit(store: number, pin: Pin): void {
    this.store = store
    this.pin = pin
  }
}

function placed(row: RendererTextFrameRow | WorkerRevisionRow, y: number): RendererTextFrameRow {
  if ('y' in row && row.y === y) return row
  return Object.freeze({ y, text: row.text, cells: row.cells, continuations: row.continuations })
}
function resolveRows(message: FrameMessage, old: Pin) {
  const added = new Map<number, WorkerRevisionRow>()
  const references = new Set(message.revisions)
  const missing = Array.from(references).filter((revision) => !old.has(revision))
  for (const row of message.content) {
    if (!references.has(row.revision) || old.has(row.revision) || added.has(row.revision))
      throw workerError('protocol', 'frame.revision', { revision: row.revision })
    added.set(row.revision, freezeWorkerValue(row))
  }
  if (message.content.some((row, index) => row.revision !== missing[index]))
    throw workerError('protocol', 'frame.revision', {})
  const pin = new Map<number, RendererTextFrameRow>()
  const rows = message.revisions.map((revision, y) => {
    const row = added.get(revision) ?? old.get(revision)
    if (!row) throw workerError('protocol', 'frame.revision', { y, revision })
    const result = placed(row, y)
    pin.set(revision, result)
    return result
  })
  return { pin, rows: Object.freeze(rows) }
}

function decode(
  reception: RevisionReception,
  previous: TerminalSubmittedSnapshot | undefined,
  value: unknown,
) {
  const message = parseFrame(value, reception.identity)
  if (message.frame !== message.base + 1 || message.base !== (previous?.frame ?? 0))
    throw workerError('protocol', 'frame.base', { base: message.base, frame: previous?.frame ?? 0 })
  const old = reception.stage(message.store)
  const { pin, rows } = resolveRows(message, old)
  const metadata = freezeWorkerValue(message.submission)
  const projection: RendererTextFrameSnapshot = Object.freeze({
    renderHeld: message.snapshot.renderHeld,
    cursor: freezeWorkerValue(message.snapshot.cursor),
    paintedCursor: freezeWorkerValue(message.snapshot.paintedCursor),
    rows,
  })
  const summary = submittedFrame(previous, { ...metadata, snapshot: projection })
  if (summary.frame !== message.frame) throw workerError('protocol', 'frame.base', {})
  reception.commit(message.store, pin)
  return Object.freeze({ summary, projection })
}

export function receiveRevisionFrame(
  reception: RevisionReception,
  previous: TerminalSubmittedSnapshot | undefined,
  message: unknown,
) {
  try {
    return decode(reception, previous, message)
  } catch (cause) {
    if (cause instanceof TerminalWorkerError) throw cause
    throw workerError('protocol', 'frame.shape', {
      causeType: cause instanceof Error ? cause.name : typeof cause,
    })
  }
}
