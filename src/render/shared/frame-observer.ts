import type { RenderCursorSnapshot, RenderRow } from '../../core/types.js'
import {
  attachCanvasImage,
  captureDisplayedRows,
  displayedRows,
  captureSubmission,
  capturedSubmission,
  observeDisplayedFrame,
  type CanvasImagePublisher,
  retainDisplayedFrame,
  type DisplayedFrameOptions,
  type DisplayedFrameSource,
  type DisplayedTextFrame,
} from './displayed-frame.js'
import type { NativeDisplayedFrame } from '../../core/displayed-frame.js'
import type { CursorState } from './instances/types.js'
import { copiedFrameRow } from './frame-row.js'
import type {
  RendererFrameRow,
  RendererTextFrameRow,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from './types.js'

type FrameObserverOptions = Pick<
  WebGpuTerminalRendererOptions,
  | 'rows'
  | 'onFrame'
  | 'onTextFrame'
  | 'onRowsChanged'
  | 'onRowsPainted'
  | 'onCleanUpdate'
  | 'needsFrameRows'
  | 'retainDisplayedText'
> &
  DisplayedFrameOptions

export interface PreparedFrame {
  accept(): void
  discard(): void
  notify(image?: 'drawn' | 'retained'): void
}

export class FrameObserver {
  private unpublished?: NativeDisplayedFrame
  private publisher?: CanvasImagePublisher
  private disposed = false
  private generation = 0
  private current = false
  private retained = false
  private displayedFrame?: NativeDisplayedFrame
  private fullRows: (RendererFrameRow | undefined)[] = []
  private textRows: (RendererTextFrameRow | undefined)[] = []

  private rowCount: number

  constructor(private readonly options: FrameObserverOptions) {
    this.rowCount = options.rows
  }

  activateCanvasImage(): void {
    this.publisher = this.options[attachCanvasImage]?.()
  }

  invalidate(): void {
    this.generation += 1
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
    this.dropUnpublished()
    this.publisher?.dispose()
  }

  get requiresFullRows(): boolean {
    return Boolean(this.options.onRowsPainted || (this.options.onFrame && this.rowsNeeded))
  }

  private get rowsNeeded(): boolean {
    return Boolean(this.options.onTextFrame) || (this.options.needsFrameRows?.() ?? true)
  }

  resize(rows = this.rowCount): void {
    this.invalidate()
    this.rowCount = rows
    this.retained = false
    this.clearRows()
  }

  private clearRows(): void {
    this.current = false
    this.fullRows = []
    this.textRows = []
  }

  notifyCleanUpdate(state: RenderStateSource): void {
    if (state.renderHeld) return
    this.options.onCleanUpdate?.()
  }

  emit(
    state: RenderStateSource,
    cursor: RenderCursorSnapshot,
    paintedCursor: Readonly<CursorState> | undefined,
    changed: readonly number[],
    rows?: readonly RenderRow[],
    image: 'drawn' | 'retained' = 'retained',
  ): void {
    const frame = this.capture(state, cursor, paintedCursor, changed, rows)
    frame.accept()
    frame.notify(image)
  }

  capture(
    state: RenderStateSource,
    cursor: RenderCursorSnapshot,
    paintedCursor: Readonly<CursorState> | undefined,
    changed: readonly number[],
    rows?: readonly RenderRow[],
  ): PreparedFrame {
    this.dropUnpublished()
    const generation = ++this.generation
    const { onFrame, onTextFrame, onRowsChanged, onRowsPainted } = this.options
    const changedRows = Object.freeze([...changed])
    const onDisplayedFrame = this.options[observeDisplayedFrame]
    const observesFrame = Boolean(onFrame || onTextFrame || onDisplayedFrame)
    const internalSource: RenderStateSource & DisplayedFrameSource = state
    const publishes = Boolean(onDisplayedFrame || onTextFrame)
    const rowsReader = publishes ? internalSource[captureDisplayedRows]?.() : undefined
    const submission = publishes ? this.options[captureSubmission]?.() : undefined
    const retain = internalSource[retainDisplayedFrame]
    const needsRows =
      observesFrame &&
      (this.rowsNeeded ||
        Boolean(onDisplayedFrame && (!this.options.retainDisplayedText || !retain)))
    const derived = Boolean(retain && this.options.retainDisplayedText && !onFrame)
    const ownsRows = needsRows && !derived
    const previousTextRows = ownsRows ? this.displayedFrame?.readTextRows() : undefined
    const preparedRows = ownsRows ? this.updateRows(state, changed, rows) : undefined
    const nativeFrame =
      observesFrame && this.options.retainDisplayedText
        ? retain?.call(state, { full: !this.retained })
        : undefined
    const derivedRows = needsRows && derived ? readCapturedText(nativeFrame!) : undefined
    const viewport = cursor.viewport ? Object.freeze({ ...cursor.viewport }) : undefined
    const snapshot = {
      renderHeld: state.renderHeld ?? false,
      cursor: Object.freeze({ ...cursor, viewport }),
      paintedCursor: paintedCursor ? Object.freeze({ ...paintedCursor }) : undefined,
    }
    const published =
      rowsReader || submission
        ? {
            ...snapshot,
            ...(rowsReader ? { [displayedRows]: rowsReader } : {}),
            ...(submission ? { [capturedSubmission]: submission } : {}),
          }
        : snapshot
    const fullFrame = onFrame
      ? Object.freeze({
          ...snapshot,
          rows: Object.freeze(preparedRows?.fullRows.filter(defined) ?? []),
        })
      : undefined
    const ownedTextRows = preparedRows
      ? Object.freeze(preparedRows.textRows.filter(defined))
      : derivedRows
    const displayedFrame: DisplayedTextFrame | undefined = onDisplayedFrame
      ? Object.freeze({
          ...published,
          nativeFrame,
          previousTextRows,
          get rows() {
            return ownedTextRows ?? nativeFrame!.readTextRows()
          },
        })
      : undefined
    const textFrame = onTextFrame
      ? Object.freeze({ ...published, rows: ownedTextRows! })
      : undefined
    let settled = false
    let accepted = false
    const isCurrent = () => !this.disposed && generation === this.generation
    return {
      accept: () => {
        if (settled) return
        settled = true
        if (!isCurrent()) {
          nativeFrame?.discard()
          return
        }
        this.unpublished = nativeFrame
        this.current = Boolean(preparedRows)
        this.fullRows = preparedRows?.fullRows ?? []
        this.textRows = preparedRows?.textRows ?? []
        accepted = true
      },
      discard: () => {
        if (settled) return
        settled = true
        nativeFrame?.discard()
      },
      notify: (image = 'retained') => {
        try {
          if (!accepted || !isCurrent()) return
          if (image === 'drawn') this.publisher?.notify(isCurrent)
          if (!isCurrent()) return
          if (fullFrame) onFrame?.(fullFrame)
          if (!isCurrent()) return
          this.publish(nativeFrame)
          if (displayedFrame) onDisplayedFrame?.(displayedFrame)
          if (!isCurrent()) return
          if (textFrame) onTextFrame?.(textFrame)
          if (!isCurrent()) return
          if (rows) onRowsPainted?.(rows)
          if (!isCurrent()) return
          onRowsChanged?.(changedRows)
        } finally {
          if (nativeFrame && this.unpublished === nativeFrame) this.dropUnpublished()
        }
      },
    }
  }

  private publish(frame: NativeDisplayedFrame | undefined): void {
    if (!frame || this.unpublished !== frame) return
    this.unpublished = undefined
    frame.accept()
    this.retained = true
    this.displayedFrame = frame
  }

  private dropUnpublished(): void {
    const frame = this.unpublished
    if (!frame) return
    this.unpublished = undefined
    frame.discard()
    // Acknowledged damage from a dropped image must be included in the next publication.
    this.retained = false
  }

  private updateRows(
    state: RenderStateSource,
    changed: readonly number[],
    rows: readonly RenderRow[] | undefined,
  ) {
    const fullRows = this.current ? this.fullRows.slice() : []
    const textRows = this.current ? this.textRows.slice() : []
    const options = this.current ? { rows: new Set(changed), packed: true } : { packed: true }
    if (this.options.onFrame) {
      const source =
        rows && (this.current || rows.length === this.rowCount) ? rows : state.readRows(options)
      for (const row of source) fullRows[row.y] = copiedFrameRow(row)
    }
    if (this.options.onTextFrame || this.options[observeDisplayedFrame]) {
      const source = this.readTextRows(state, options, rows, fullRows)
      for (const row of source) textRows[row.y] = row
    }
    return { fullRows, textRows }
  }

  private readTextRows(
    state: RenderStateSource,
    options: { packed: boolean; rows?: ReadonlySet<number> },
    rows: readonly RenderRow[] | undefined,
    fullRows: readonly (RendererFrameRow | undefined)[],
  ): readonly RendererTextFrameRow[] {
    if (this.options.onFrame) return fullRows.filter(defined)
    if (rows && (this.current || rows.length === this.rowCount)) return rows.map(copiedPaintTextRow)
    if (state.readTextRows) return state.readTextRows(options)
    const source = this.current && rows ? rows : state.readRows(options)
    return source.map(copiedPaintTextRow)
  }
}

function copiedPaintTextRow(row: RenderRow): RendererTextFrameRow {
  if (row.packed) return copiedFrameRow(row)
  const texts = row.cells.map((cell) => cell.text)
  const flags = row.cells.map((cell) => cell.continuation)
  let text = ''
  for (let index = 0; index < texts.length; index += 1) {
    if (flags[index]) continue
    text += texts[index] || ' '
  }
  let cells: readonly string[] | undefined
  let continuations: readonly boolean[] | undefined
  return Object.freeze({
    y: row.y,
    text,
    get cells() {
      return (cells ??= Object.freeze(texts))
    },
    get continuations() {
      return (continuations ??= Object.freeze(flags))
    },
  })
}

function readCapturedText(frame: NativeDisplayedFrame): readonly RendererTextFrameRow[] {
  try {
    return frame.readTextRows()
  } catch (cause) {
    frame.discard()
    throw cause
  }
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined
}
