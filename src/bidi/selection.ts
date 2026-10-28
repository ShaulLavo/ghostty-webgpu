import { GhosttySelectionGesture } from '../core/selection.js'
import type {
  SelectionPoint,
  SelectionPressEvent,
  SelectionDragEvent,
  SelectionGestureUpdate,
} from '../core/selection.js'
import type { GhosttyTerminal } from '../core/terminal.js'
import type { GhosttyRenderState } from '../core/render-state.js'
import type { RenderRow, TerminalSelectionFormatOptions } from '../core/types.js'
import { RowBidiMapper } from './row.js'
import { CellPin } from './pin.js'

function order(a: SelectionPoint, b: SelectionPoint): number {
  return a.y - b.y || a.x - b.x
}

export class BidiSelectionGesture extends GhosttySelectionGesture {
  private readonly mapper = new RowBidiMapper()
  private mask?: { readonly pins: CellPin[]; readonly rectangle: boolean }
  private gesture?: {
    readonly anchor: SelectionPoint
    readonly pin: CellPin
    readonly kind: 'cells' | 'native'
  }

  constructor(
    private readonly vt: GhosttyTerminal,
    private readonly source: GhosttyRenderState,
  ) {
    super(vt)
  }

  logical(point: SelectionPoint): SelectionPoint {
    this.source.update()
    const row = this.source.readRows({ rows: new Set([point.y]) }).find((row) => row.y === point.y)
    if (!row) return point
    return { x: this.mapper.getMap(row.cells).visualToLogical[point.x] ?? point.x, y: point.y }
  }

  override press(input: SelectionPressEvent): SelectionGestureUpdate {
    this.clearPins()
    const point = this.logical(input.viewport)
    const update = super.press({ ...input, viewport: point })
    this.clearGesture()
    this.gesture = {
      anchor: { ...input.viewport },
      pin: new CellPin(this.vt, point),
      kind: update.selectionInstalled ? 'native' : 'cells',
    }
    return update
  }

  override drag(input: SelectionDragEvent): SelectionGestureUpdate {
    const update = super.drag({ ...input, viewport: this.logical(input.viewport) })
    return this.updateVisualSelection(input, update)
  }

  override autoscrollTick(input: SelectionDragEvent): SelectionGestureUpdate {
    const update = super.autoscrollTick({ ...input, viewport: this.logical(input.viewport) })
    return this.updateVisualSelection(input, update)
  }

  private updateVisualSelection(
    input: SelectionDragEvent,
    update: SelectionGestureUpdate,
  ): SelectionGestureUpdate {
    const gesture = this.gesture
    if (!gesture || gesture.kind === 'native') return update
    const anchor = gesture.anchor
    const offset = this.vt.scrollbar.offset
    const pinned = gesture.pin.point()
    const projected = { x: anchor.x, y: pinned ? pinned.y - offset : anchor.y }
    const points = this.visualRange(projected, input.viewport, input.rectangle === true)
    const first = Math.min(projected.y, input.viewport.y) + offset
    const last = Math.max(projected.y, input.viewport.y) + offset
    const retained = this.retainHiddenPins(first, last)
    for (const pin of this.mask?.pins ?? []) {
      if (!retained.includes(pin)) pin.dispose()
    }
    const rectangle = input.rectangle === true
    this.mask = {
      pins: retained.concat(points.map((point) => new CellPin(this.vt, point))),
      rectangle,
    }
    const selected = this.points()
    if (selected.length === 0) return update
    const start = { ...selected[0]! }
    const end = { ...selected.at(-1)! }
    if (rectangle) {
      start.x = Math.min(...selected.map((point) => point.x))
      end.x = Math.max(...selected.map((point) => point.x))
    }
    const range = this.installRange(start, end, rectangle)
    return { ...range, autoscroll: update.autoscroll, selectionChanged: true }
  }

  private retainHiddenPins(first: number, last: number): CellPin[] {
    const offset = this.vt.scrollbar.offset
    return (this.mask?.pins ?? []).filter((pin) => {
      const point = pin.point()
      if (!point || point.y < first || point.y > last) return false
      return point.y < offset || point.y >= offset + this.vt.size.rows
    })
  }

  override release(input?: SelectionPoint) {
    const dragged = this.mask !== undefined
    this.clearGesture()
    const update = super.release(input ? this.logical(input) : input)
    return { ...update, dragged: update.dragged || dragged }
  }

  override reset(): void {
    this.clearGesture()
    super.reset()
  }

  override clear(): boolean {
    this.clearPins()
    return super.clear()
  }

  override selectRange(start: SelectionPoint, end: SelectionPoint): SelectionGestureUpdate {
    this.clearPins()
    return super.selectRange(start, end)
  }

  override selectAll(): SelectionGestureUpdate {
    this.clearPins()
    return super.selectAll()
  }

  selectedRows(rows: readonly RenderRow[]): readonly RenderRow[] {
    if (!this.mask) return rows
    if (!this.hasSelection) this.clearPins()
    if (!this.mask) return rows
    const selected = new Set(this.points().map((point) => `${point.y}:${point.x}`))
    const offset = this.vt.scrollbar.offset
    return rows.map((row) => ({
      ...row,
      packed: undefined,
      cells: row.cells.map((cell) => ({
        ...cell,
        selected:
          selected.has(`${row.y + offset}:${cell.x}`) ||
          (cell.continuation && selected.has(`${row.y + offset}:${cell.x - 1}`)),
      })),
    }))
  }

  override getSelection(options: TerminalSelectionFormatOptions = {}): string | undefined {
    if (!this.hasSelection) this.clearPins()
    if (!this.mask) return super.getSelection(options)
    const points = this.points()
    if (options.format && options.format !== 'plain')
      return this.formattedSelection(points, options)
    let text = ''
    let previous: SelectionPoint | undefined
    for (const point of points) {
      if (previous && this.lineBreak(previous, point, options))
        text = `${options.trim === false ? text : text.trimEnd()}\n`
      text +=
        super.readRangeText(
          { start: point, end: point, rectangle: false },
          { ...options, trim: false },
        ) ?? ''
      previous = point
    }
    return options.trim === false ? text : text.trimEnd()
  }

  private formattedSelection(
    points: readonly SelectionPoint[],
    options: TerminalSelectionFormatOptions,
  ): string | undefined {
    const scratch = this.vt.runtime.createTerminal(this.vt.size)
    const selection = new GhosttySelectionGesture(scratch)
    try {
      scratch.setScrollbackLimit(undefined)
      scratch.write('\x1b[?2027h')
      let previous: SelectionPoint | undefined
      for (const run of this.runs(points)) {
        if (previous && this.lineBreak(previous, run.start, options)) scratch.write('\r\n')
        scratch.write(
          super.readRangeText({ ...run, rectangle: false }, { format: 'vt', trim: false }) ?? '',
        )
        previous = run.end
      }
      const cursor = scratch.cursor
      const end = {
        x: Math.max(0, cursor.x - Number(!cursor.pendingWrap)),
        y: scratch.scrollbar.offset + cursor.y,
      }
      selection.selectRange({ x: 0, y: 0 }, end)
      return selection.getSelection(options)
    } finally {
      selection.dispose()
      scratch.dispose()
    }
  }

  private runs(
    points: readonly SelectionPoint[],
  ): { start: SelectionPoint; end: SelectionPoint }[] {
    const runs: { start: SelectionPoint; end: SelectionPoint }[] = []
    for (const point of points) {
      const previous = runs.at(-1)
      if (previous && previous.end.y === point.y && previous.end.x + 1 === point.x) {
        previous.end = point
        continue
      }
      runs.push({ start: point, end: point })
    }
    return runs
  }

  override dispose(): void {
    this.clearPins()
    this.clearGesture()
    super.dispose()
  }

  private lineBreak(
    previous: SelectionPoint,
    point: SelectionPoint,
    options: TerminalSelectionFormatOptions,
  ): boolean {
    if (previous.y === point.y) return false
    if (options.unwrap === false || this.mask?.rectangle) return true
    return this.vt.readLines(previous.y, point.y).some((line) => !line.wrapped)
  }

  private clearGesture(): void {
    this.gesture?.pin.dispose()
    this.gesture = undefined
  }

  private points(): SelectionPoint[] {
    const points =
      this.mask?.pins.flatMap((pin) => {
        const point = pin.point()
        return point ? [point] : []
      }) ?? []
    points.sort(order)
    return points
  }

  private clearPins(): void {
    for (const pin of this.mask?.pins ?? []) pin.dispose()
    this.mask = undefined
  }

  private visualRange(
    anchor: SelectionPoint,
    end: SelectionPoint,
    rectangle: boolean,
  ): SelectionPoint[] {
    const first = order(anchor, end) <= 0 ? anchor : end
    const last = first === anchor ? end : anchor
    this.source.update()
    const rows = this.source.readRows()
    return rows
      .flatMap((row) => {
        if (row.y < first.y || row.y > last.y) return []
        const start = row.y === first.y ? first.x : 0
        const finish = row.y === last.y ? last.x : row.cells.length - 1
        const left = rectangle ? Math.min(anchor.x, end.x) : start
        const right = rectangle ? Math.max(anchor.x, end.x) : finish
        return this.mapper
          .getMap(row.cells)
          .visualToLogical.slice(left, right + 1)
          .map((x) => (row.cells[x]!.continuation ? Math.max(0, x - 1) : x))
          .filter((x, index, columns) => columns.indexOf(x) === index)
          .map((x) => ({ x, y: row.y }))
      })
      .sort(order)
  }
}
