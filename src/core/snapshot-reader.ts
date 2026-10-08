import { GhosttyResult } from './abi.js'
import { assertGhosttyResult } from './error.js'
import type { GhosttyRuntime } from './runtime.js'
import type { ReadTextRowsOptions, TerminalSize } from './types.js'

// Text packets append a codepoint mask; paint packets leave the last word unused.
const headerBytes = 40

type ExtractSnapshot = (
  state: number,
  iterator: number,
  cells: number,
  mask: number,
  maskLength: number,
  dirtyOnly: number,
  snapshot: number,
) => number

interface SnapshotFormat {
  rowWords: number
  cellWords: number
  operation: string
  extract: ExtractSnapshot
}

export class SnapshotReader {
  private pointer = 0
  private size = 0
  private rowsCapacity = 0
  private cellsCapacity = 0
  private graphemesPointer = 0
  private graphemesCapacity = 0

  constructor(
    private readonly runtime: GhosttyRuntime,
    private readonly format: SnapshotFormat,
  ) {}

  get codepointMask(): number {
    return this.runtime.memory.view.getUint32(this.pointer + 36, true)
  }

  // Views are borrowed until the next wasm call; consumers copy or decode before returning.
  read(
    state: number,
    iterator: number,
    cells: number,
    grid: Pick<TerminalSize, 'columns' | 'rows'>,
    options: ReadTextRowsOptions,
  ): { rows: Uint32Array; cells: Uint32Array; graphemes: Uint32Array } {
    this.reserve(grid)
    const rowsPointer = this.pointer + headerBytes
    const cellsPointer = rowsPointer + this.rowsCapacity * this.format.rowWords * 4
    const maskPointer = cellsPointer + this.cellsCapacity * this.format.cellWords * 4
    if (options.rows) {
      const mask = this.runtime.memory.bytes.subarray(maskPointer, maskPointer + grid.rows)
      mask.fill(0)
      for (const row of options.rows) {
        if (Number.isInteger(row) && row >= 0 && row < grid.rows) mask[row] = 1
      }
    }
    const extract = () =>
      this.format.extract(
        state,
        iterator,
        cells,
        options.rows ? maskPointer : 0,
        grid.rows,
        Number(options.dirtyOnly === true),
        this.pointer,
      )
    let result = extract()
    if (result === GhosttyResult.OutOfSpace) {
      const required = this.runtime.memory.view.getUint32(this.pointer + 32, true)
      if (required <= this.graphemesCapacity) assertGhosttyResult(this.format.operation, result)
      this.reserveGraphemes(required)
      result = extract()
    }
    assertGhosttyResult(this.format.operation, result)
    const view = this.runtime.memory.view
    const rowsLength = view.getUint32(this.pointer + 8, true)
    const cellsLength = view.getUint32(this.pointer + 20, true)
    const graphemesLength = view.getUint32(this.pointer + 32, true)
    const buffer = this.runtime.exports.memory.buffer
    return {
      rows: new Uint32Array(buffer, rowsPointer, rowsLength * this.format.rowWords),
      cells: new Uint32Array(buffer, cellsPointer, cellsLength * this.format.cellWords),
      graphemes: new Uint32Array(buffer, this.graphemesPointer, graphemesLength),
    }
  }

  dispose(): void {
    if (this.pointer !== 0) this.runtime.memory.free(this.pointer, this.size)
    if (this.graphemesPointer !== 0)
      this.runtime.memory.free(this.graphemesPointer, this.graphemesCapacity * 4)
  }

  private reserve(grid: Pick<TerminalSize, 'columns' | 'rows'>): void {
    const capacity = grid.rows * grid.columns
    if (grid.rows <= this.rowsCapacity && capacity <= this.cellsCapacity) return
    const size =
      headerBytes +
      grid.rows * this.format.rowWords * 4 +
      capacity * this.format.cellWords * 4 +
      grid.rows
    const pointer = this.runtime.memory.allocate(size)
    if (this.pointer !== 0) this.runtime.memory.free(this.pointer, this.size)
    this.pointer = pointer
    this.size = size
    this.rowsCapacity = grid.rows
    this.cellsCapacity = capacity
    const view = this.runtime.memory.view
    view.setUint32(pointer, pointer + headerBytes, true)
    view.setUint32(pointer + 4, grid.rows, true)
    view.setUint32(pointer + 12, pointer + headerBytes + grid.rows * this.format.rowWords * 4, true)
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
