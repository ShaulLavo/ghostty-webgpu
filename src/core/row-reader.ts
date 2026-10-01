import { GhosttyResult } from './abi.js'
import { assertGhosttyResult } from './error.js'
import { PACKED_CELL_WORDS, PACKED_ROW_WORDS, PackedCells } from './packed-cells.js'
import type { GhosttyRuntime } from './runtime.js'
import type { ReadRowsOptions, RenderRow, TerminalSize } from './types.js'

const headerBytes = 36

export class RowReader {
  private pointer = 0
  private size = 0
  private rowsCapacity = 0
  private cellsCapacity = 0
  private graphemesPointer = 0
  private graphemesCapacity = 0

  constructor(private readonly runtime: GhosttyRuntime) {}

  read(
    state: number,
    iterator: number,
    cells: number,
    grid: Pick<TerminalSize, 'columns' | 'rows'>,
    options: ReadRowsOptions,
  ): readonly RenderRow[] {
    if (grid.rows === 0) return []
    this.reserve(grid)
    const rowsPointer = this.pointer + headerBytes
    const cellsPointer = rowsPointer + this.rowsCapacity * PACKED_ROW_WORDS * 4
    const maskPointer = cellsPointer + this.cellsCapacity * PACKED_CELL_WORDS * 4
    if (options.rows) {
      const mask = this.runtime.memory.bytes.subarray(maskPointer, maskPointer + grid.rows)
      mask.fill(0)
      for (const row of options.rows) {
        if (Number.isInteger(row) && row >= 0 && row < grid.rows) mask[row] = 1
      }
    }
    let result = this.extract(
      state,
      iterator,
      cells,
      options.rows ? maskPointer : 0,
      grid.rows,
      options.dirtyOnly === true,
    )
    if (result === GhosttyResult.OutOfSpace) {
      const required = this.runtime.memory.view.getUint32(this.pointer + 32, true)
      this.reserveGraphemes(required)
      result = this.extract(
        state,
        iterator,
        cells,
        options.rows ? maskPointer : 0,
        grid.rows,
        options.dirtyOnly === true,
      )
    }
    assertGhosttyResult('bridge_read_rows', result)
    const view = this.runtime.memory.view
    const rowsLength = view.getUint32(this.pointer + 8, true)
    const cellsLength = view.getUint32(this.pointer + 20, true)
    const graphemesLength = view.getUint32(this.pointer + 32, true)
    const buffer = this.runtime.exports.memory.buffer
    const records = new Uint32Array(buffer, cellsPointer, cellsLength * PACKED_CELL_WORDS).slice()
    const graphemes = new Uint32Array(buffer, this.graphemesPointer, graphemesLength).slice()
    const rows: RenderRow[] = []
    for (let index = 0; index < rowsLength; index += 1) {
      const offset = rowsPointer + index * PACKED_ROW_WORDS * 4
      const y = view.getUint32(offset, true)
      const dirty = view.getUint32(offset + 4, true) !== 0
      const start = view.getUint32(offset + 8, true) * PACKED_CELL_WORDS
      const length = view.getUint32(offset + 12, true) * PACKED_CELL_WORDS
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
    if (this.pointer !== 0) this.runtime.memory.free(this.pointer, this.size)
    if (this.graphemesPointer !== 0)
      this.runtime.memory.free(this.graphemesPointer, this.graphemesCapacity * 4)
  }

  private extract(
    state: number,
    iterator: number,
    cells: number,
    mask: number,
    maskLength: number,
    dirtyOnly: boolean,
  ): number {
    return this.runtime.bridge.readRows(
      state,
      iterator,
      cells,
      mask,
      maskLength,
      Number(dirtyOnly),
      this.pointer,
    )
  }

  private reserve(grid: Pick<TerminalSize, 'columns' | 'rows'>): void {
    const capacity = grid.rows * grid.columns
    if (grid.rows <= this.rowsCapacity && capacity <= this.cellsCapacity) return
    const size =
      headerBytes + grid.rows * PACKED_ROW_WORDS * 4 + capacity * PACKED_CELL_WORDS * 4 + grid.rows
    const pointer = this.runtime.memory.allocate(size)
    if (this.pointer !== 0) this.runtime.memory.free(this.pointer, this.size)
    this.pointer = pointer
    this.size = size
    this.rowsCapacity = grid.rows
    this.cellsCapacity = capacity
    const view = this.runtime.memory.view
    view.setUint32(pointer, pointer + headerBytes, true)
    view.setUint32(pointer + 4, grid.rows, true)
    view.setUint32(pointer + 12, pointer + headerBytes + grid.rows * PACKED_ROW_WORDS * 4, true)
    view.setUint32(pointer + 16, capacity, true)
    view.setUint32(pointer + 24, this.graphemesPointer, true)
    view.setUint32(pointer + 28, this.graphemesCapacity, true)
  }

  private reserveGraphemes(capacity: number): void {
    const pointer = this.runtime.memory.allocate(capacity * 4)
    if (this.graphemesPointer !== 0)
      this.runtime.memory.free(this.graphemesPointer, this.graphemesCapacity * 4)
    this.graphemesPointer = pointer
    this.graphemesCapacity = capacity
    const view = this.runtime.memory.view
    view.setUint32(this.pointer + 24, pointer, true)
    view.setUint32(this.pointer + 28, capacity, true)
  }
}
