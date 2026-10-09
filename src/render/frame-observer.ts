import type { RenderCursorSnapshot, RenderRow } from '../core/types.js'
import {
  observeDisplayedFrame,
  retainDisplayedFrame,
  type DisplayedFrameOptions,
  type DisplayedFrameSource,
  type DisplayedTextFrame,
} from './displayed-frame.js'
import type { NativeDisplayedFrame } from '../core/displayed-frame.js'
import type { CursorState } from './instances/types.js'
import { copiedFrameRow } from './frame-row.js'
import type {
  RendererFrameRow,
  RendererTextFrameRow,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from './renderer.js'

export interface PreparedFrame {
  accept(): void
  discard(): void
  notify(): void
}

export class FrameObserver {
  private generation = 0
  private current = false
  private retained = false
  private displayedFrame?: NativeDisplayedFrame
  private fullRows: (RendererFrameRow | undefined)[] = []
  private textRows: (RendererTextFrameRow | undefined)[] = []

  private rowCount: number

  constructor(private readonly options: WebGpuTerminalRendererOptions) {
    this.rowCount = options.rows
  }

  get requiresFullRows(): boolean {
    return Boolean(this.options.onRowsPainted || (this.options.onFrame && this.rowsNeeded))
  }

  private get rowsNeeded(): boolean {
    return Boolean(this.options.onTextFrame) || (this.options.needsFrameRows?.() ?? true)
  }

  resize(rows = this.rowCount): void {
    this.rowCount = rows
    this.retained = false
    this.clearRows()
  }

  private clearRows(): void {
    this.current = false
    this.fullRows = []
    this.textRows = []
  }

  notifyCleanUpdate(): void {
    this.options.onCleanUpdate?.()
  }

  emit(
    state: RenderStateSource,
    cursor: RenderCursorSnapshot,
    paintedCursor: Readonly<CursorState> | undefined,
    changed: readonly number[],
    rows?: readonly RenderRow[],
  ): void {
    const frame = this.capture(state, cursor, paintedCursor, changed, rows)
    frame.accept()
    frame.notify()
  }

  capture(
    state: RenderStateSource,
    cursor: RenderCursorSnapshot,
    paintedCursor: Readonly<CursorState> | undefined,
    changed: readonly number[],
    rows?: readonly RenderRow[],
  ): PreparedFrame {
    const generation = ++this.generation
    const { onFrame, onTextFrame, onRowsChanged, onRowsPainted } = this.options
    const changedRows = Object.freeze([...changed])
    const onDisplayedFrame = (this.options as DisplayedFrameOptions)[observeDisplayedFrame]
    const observesFrame = Boolean(onFrame || onTextFrame || onDisplayedFrame)
    const retain = (state as DisplayedFrameSource)[retainDisplayedFrame]
    const needsRows =
      observesFrame &&
      (this.rowsNeeded ||
        Boolean(onDisplayedFrame && (!this.options.retainDisplayedText || !retain)))
    const previousTextRows = needsRows ? this.displayedFrame?.readTextRows() : undefined
    const preparedRows = needsRows ? this.updateRows(state, changed, rows) : undefined
    const nativeFrame =
      observesFrame && this.options.retainDisplayedText
        ? retain?.call(state, { full: !this.retained })
        : undefined
    const viewport = cursor.viewport ? Object.freeze({ ...cursor.viewport }) : undefined
    const snapshot = {
      cursor: Object.freeze({ ...cursor, viewport }),
      paintedCursor: paintedCursor ? Object.freeze({ ...paintedCursor }) : undefined,
    }
    const fullFrame = onFrame
      ? Object.freeze({
          ...snapshot,
          rows: Object.freeze(preparedRows?.fullRows.filter(defined) ?? []),
        })
      : undefined
    const ownedTextRows = preparedRows
      ? Object.freeze(preparedRows.textRows.filter(defined))
      : undefined
    const displayedFrame: DisplayedTextFrame | undefined = onDisplayedFrame
      ? Object.freeze({
          ...snapshot,
          nativeFrame,
          previousTextRows,
          get rows() {
            return ownedTextRows ?? nativeFrame!.readTextRows()
          },
        })
      : undefined
    const textFrame = onTextFrame ? Object.freeze({ ...snapshot, rows: ownedTextRows! }) : undefined
    let settled = false
    let accepted = false
    return {
      accept: () => {
        if (settled) return
        settled = true
        if (generation !== this.generation) {
          nativeFrame?.discard()
          return
        }
        nativeFrame?.accept()
        if (nativeFrame) {
          this.retained = true
          this.displayedFrame = nativeFrame
        }
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
      notify: () => {
        if (!accepted || generation !== this.generation) return
        if (fullFrame) onFrame?.(fullFrame)
        if (generation !== this.generation) return
        if (displayedFrame) onDisplayedFrame?.(displayedFrame)
        if (generation !== this.generation) return
        if (textFrame) onTextFrame?.(textFrame)
        if (generation !== this.generation) return
        if (rows) onRowsPainted?.(rows)
        if (generation !== this.generation) return
        onRowsChanged?.(changedRows)
      },
    }
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
    if (
      this.options.onTextFrame ||
      (this.options as DisplayedFrameOptions)[observeDisplayedFrame]
    ) {
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

function defined<T>(value: T | undefined): value is T {
  return value !== undefined
}
