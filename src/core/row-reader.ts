import { PACKED_CELL_WORDS, PACKED_ROW_WORDS, PackedCells } from './packed-cells.js'
import { SnapshotReader, type ExtractSnapshot } from './snapshot-reader.js'
import type { GhosttyRuntime } from './runtime.js'
import type { ReadRowsOptions, RenderRow, TerminalSize } from './types.js'

export class RowReader {
  private readonly snapshots: SnapshotReader

  constructor(runtime: GhosttyRuntime, extract?: ExtractSnapshot) {
    this.snapshots = new SnapshotReader(runtime, {
      rowWords: PACKED_ROW_WORDS,
      cellWords: PACKED_CELL_WORDS,
      operation: 'bridge_read_rows',
      extract: extract ?? ((...args) => runtime.bridge.readRows(...args)),
    })
  }

  read(
    state: number,
    iterator: number,
    cells: number,
    grid: Pick<TerminalSize, 'columns' | 'rows'>,
    options: ReadRowsOptions,
  ): readonly RenderRow[] {
    if (grid.rows === 0) return []
    const snapshot = this.snapshots.read(state, iterator, cells, grid, options)
    const records = snapshot.cells.slice()
    const graphemes = snapshot.graphemes.slice()
    const rows: RenderRow[] = []
    for (let offset = 0; offset < snapshot.rows.length; offset += PACKED_ROW_WORDS) {
      const y = snapshot.rows[offset]!
      const dirty = snapshot.rows[offset + 1]! !== 0
      const start = snapshot.rows[offset + 2]! * PACKED_CELL_WORDS
      const length = snapshot.rows[offset + 3]! * PACKED_CELL_WORDS
      const packed = new PackedCells(records.subarray(start, start + length), graphemes)
      if (!options.packed) {
        rows.push({ y, dirty, cells: packed.materialize() })
        continue
      }
      let materialized: RenderRow['cells'] | undefined
      rows.push({
        y,
        dirty,
        packed,
        get cells() {
          return (materialized ??= packed.materialize())
        },
      })
    }
    return rows
  }

  dispose(): void {
    this.snapshots.dispose()
  }
}
