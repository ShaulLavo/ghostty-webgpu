import type { NativeDisplayedFrame } from '../core/displayed-frame.js'
import type { RenderRow, RenderTextRow } from '../core/types.js'

export type BidiSelectionOverlay = ReadonlyMap<number, ReadonlySet<number>>

/** Missing rows are unselected, including stale native logical selection bits. */
export function overlaidRows(
  rows: readonly RenderRow[],
  overlay: BidiSelectionOverlay,
): readonly RenderRow[] {
  return rows.map((row) => {
    const columns = overlay.get(row.y)
    return {
      ...row,
      packed: undefined,
      cells: row.cells.map((cell) => ({
        ...cell,
        selected:
          columns?.has(cell.x) === true || (cell.continuation && columns?.has(cell.x - 1) === true),
      })),
    }
  })
}

/** Owns captured numeric coordinates, never pins or a live gesture. */
export class SelectedDisplayedFrame implements NativeDisplayedFrame {
  readonly #frame: NativeDisplayedFrame
  readonly #overlay: BidiSelectionOverlay

  constructor(frame: NativeDisplayedFrame, overlay: BidiSelectionOverlay) {
    this.#frame = frame
    this.#overlay = overlay
  }
  get token(): number {
    return this.#frame.token
  }
  get revisionSource(): object {
    return this.#frame.revisionSource
  }
  accept(): void {
    this.#frame.accept()
  }
  discard(): void {
    this.#frame.discard()
  }
  readTextRevisions(): readonly number[] {
    return this.#frame.readTextRevisions()
  }
  readTextRows(
    options?: Parameters<NativeDisplayedFrame['readTextRows']>[0],
  ): readonly RenderTextRow[] {
    return this.#frame.readTextRows(options)
  }
  readPreviousTextRows(): readonly RenderTextRow[] {
    return this.#frame.readPreviousTextRows()
  }
  readRows(options?: Parameters<NativeDisplayedFrame['readRows']>[0]): readonly RenderRow[] {
    return overlaidRows(this.#frame.readRows(options), this.#overlay)
  }
}
