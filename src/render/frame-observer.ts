import type { RenderCursorSnapshot, RenderRow } from '../core/types.js'
import type { CursorState } from './instances/types.js'
import { copiedFrameRow } from './frame-row.js'
import type {
  RendererFrameRow,
  RendererTextFrameRow,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from './renderer.js'

export class FrameObserver {
  private generation = 0
  private current = false
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
    return this.options.needsFrameRows?.() ?? true
  }

  resize(rows = this.rowCount): void {
    this.rowCount = rows
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
    this.capture(state, cursor, paintedCursor, changed, rows)()
  }

  capture(
    state: RenderStateSource,
    cursor: RenderCursorSnapshot,
    paintedCursor: Readonly<CursorState> | undefined,
    changed: readonly number[],
    rows?: readonly RenderRow[],
  ): () => void {
    const generation = ++this.generation
    const { onFrame, onTextFrame, onRowsChanged, onRowsPainted } = this.options
    const changedRows = Object.freeze([...changed])
    if (!onFrame && !onTextFrame) return this.rowDelivery(generation, changedRows, rows)
    if (this.rowsNeeded) this.updateRows(state, changed, rows)
    else this.resize()
    const viewport = cursor.viewport ? Object.freeze({ ...cursor.viewport }) : undefined
    const snapshot = {
      cursor: Object.freeze({ ...cursor, viewport }),
      paintedCursor: paintedCursor ? Object.freeze({ ...paintedCursor }) : undefined,
    }
    const fullFrame = onFrame
      ? Object.freeze({
          ...snapshot,
          rows: Object.freeze(this.fullRows.filter(defined)),
        })
      : undefined
    const textFrame = onTextFrame
      ? Object.freeze({
          ...snapshot,
          rows: Object.freeze(this.textRows.filter(defined)),
        })
      : undefined
    return () => {
      if (generation !== this.generation) return
      if (fullFrame) onFrame?.(fullFrame)
      if (generation !== this.generation) return
      if (textFrame) onTextFrame?.(textFrame)
      if (generation !== this.generation) return
      if (rows) onRowsPainted?.(rows)
      if (generation !== this.generation) return
      onRowsChanged?.(changedRows)
    }
  }

  private rowDelivery(
    generation: number,
    changed: readonly number[],
    rows: readonly RenderRow[] | undefined,
  ): () => void {
    const { onRowsChanged, onRowsPainted } = this.options
    return () => {
      if (generation !== this.generation) return
      if (rows) onRowsPainted?.(rows)
      if (generation !== this.generation) return
      onRowsChanged?.(changed)
    }
  }

  private updateRows(
    state: RenderStateSource,
    changed: readonly number[],
    rows: readonly RenderRow[] | undefined,
  ): void {
    const options = this.current ? { rows: new Set(changed), packed: true } : { packed: true }
    if (this.options.onFrame) {
      const source =
        rows && (this.current || rows.length === this.rowCount) ? rows : state.readRows(options)
      for (const row of source) this.fullRows[row.y] = copiedFrameRow(row)
    }
    if (this.options.onTextFrame) {
      const source = this.readTextRows(state, options, rows)
      for (const row of source) this.textRows[row.y] = row
    }
    this.current = true
  }

  private readTextRows(
    state: RenderStateSource,
    options: { packed: boolean; rows?: ReadonlySet<number> },
    rows: readonly RenderRow[] | undefined,
  ): readonly RendererTextFrameRow[] {
    if (this.options.onFrame) return this.fullRows.filter(defined)
    if (rows && (this.current || rows.length === this.rowCount)) return rows.map(copiedFrameRow)
    if (state.readTextRows) return state.readTextRows(options)
    const source = this.current && rows ? rows : state.readRows(options)
    return source.map(copiedFrameRow)
  }
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined
}
