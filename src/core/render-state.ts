import {
  GhosttyResult,
  RenderStateCellData,
  RenderStateData,
  RenderStateDirty,
  RenderStateOption,
  RenderStateRowData,
  RenderStateRowOption,
} from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import { requireLayout } from './memory.js'
import type { GhosttyRuntime } from './runtime.js'
import type { GhosttyTerminal } from './terminal.js'
import type {
  CellStyle,
  DamageSnapshot,
  ReadRowsOptions,
  RenderCell,
  RenderRow,
  RgbColor,
} from './types.js'

interface OwnedHandle {
  handle: number
  out: number
}

function createOwnedHandle(
  runtime: GhosttyRuntime,
  operation: string,
  create: (out: number) => number,
): OwnedHandle {
  const out = runtime.memory.allocateOpaque()
  try {
    assertGhosttyResult(operation, create(out))
    const handle = runtime.memory.readHandle(out)
    if (handle !== 0) return { handle, out }
    throw createGhosttyError(operation, `${operation} returned a null handle`)
  } catch (cause) {
    runtime.memory.freeOpaque(out)
    throw cause
  }
}

class CellReader {
  private readonly boolPointer: number
  private readonly bufferLayout
  private readonly bufferPointer: number
  private readonly colorPointer: number
  private readonly runtime: GhosttyRuntime
  private readonly styleLayout
  private readonly stylePointer: number
  private readonly textCapacity = 64
  private readonly textPointer: number

  constructor(runtime: GhosttyRuntime) {
    this.runtime = runtime
    this.bufferLayout = requireLayout(runtime.layouts, 'GhosttyBuffer')
    this.styleLayout = requireLayout(runtime.layouts, 'GhosttyStyle')
    this.boolPointer = runtime.memory.allocate(1)
    this.bufferPointer = runtime.memory.allocate(this.bufferLayout.size)
    this.colorPointer = runtime.memory.allocate(3)
    this.stylePointer = runtime.memory.allocate(this.styleLayout.size)
    this.textPointer = runtime.memory.allocate(this.textCapacity)
  }

  read(cells: number, x: number): RenderCell {
    const hasStyling = this.readBoolean(cells, RenderStateCellData.HasStyling)
    return {
      background: this.readColor(cells, RenderStateCellData.BackgroundColor),
      foreground: this.readColor(cells, RenderStateCellData.ForegroundColor),
      selected: this.readBoolean(cells, RenderStateCellData.Selected),
      style: hasStyling ? this.readStyle(cells) : undefined,
      text: this.readText(cells),
      x,
    }
  }

  dispose(): void {
    this.runtime.memory.free(this.boolPointer, 1)
    this.runtime.memory.free(this.bufferPointer, this.bufferLayout.size)
    this.runtime.memory.free(this.colorPointer, 3)
    this.runtime.memory.free(this.stylePointer, this.styleLayout.size)
    this.runtime.memory.free(this.textPointer, this.textCapacity)
  }

  private get exports() {
    return this.runtime.exports
  }

  private readBoolean(cells: number, data: RenderStateCellData): boolean {
    assertGhosttyResult(
      `ghostty_render_state_row_cells_get(${data})`,
      this.exports.ghostty_render_state_row_cells_get(cells, data, this.boolPointer),
    )
    return this.runtime.memory.view.getUint8(this.boolPointer) !== 0
  }

  private readColor(cells: number, data: RenderStateCellData): RgbColor | undefined {
    const result = this.exports.ghostty_render_state_row_cells_get(cells, data, this.colorPointer)
    if (result === GhosttyResult.InvalidValue) return undefined
    assertGhosttyResult(`ghostty_render_state_row_cells_get(${data})`, result)
    return {
      b: this.runtime.memory.view.getUint8(this.colorPointer + 2),
      g: this.runtime.memory.view.getUint8(this.colorPointer + 1),
      r: this.runtime.memory.view.getUint8(this.colorPointer),
    }
  }

  private readText(cells: number): string {
    this.initializeTextBuffer(this.textPointer, this.textCapacity)
    const result = this.exports.ghostty_render_state_row_cells_get(
      cells,
      RenderStateCellData.GraphemesUtf8,
      this.bufferPointer,
    )
    const length = this.readBufferLength()
    if (result === GhosttyResult.Success)
      return this.runtime.memory.decode(this.textPointer, length)
    if (result === GhosttyResult.OutOfSpace) return this.readLargeText(cells, length)
    assertGhosttyResult('ghostty_render_state_row_cells_get(GRAPHEMES_UTF8)', result)
    return ''
  }

  private readLargeText(cells: number, capacity: number): string {
    const pointer = this.runtime.memory.allocate(capacity)
    try {
      this.initializeTextBuffer(pointer, capacity)
      assertGhosttyResult(
        'ghostty_render_state_row_cells_get(GRAPHEMES_UTF8)',
        this.exports.ghostty_render_state_row_cells_get(
          cells,
          RenderStateCellData.GraphemesUtf8,
          this.bufferPointer,
        ),
      )
      return this.runtime.memory.decode(pointer, this.readBufferLength())
    } finally {
      this.runtime.memory.free(pointer, capacity)
    }
  }

  private initializeTextBuffer(pointer: number, capacity: number): void {
    const fields = this.bufferLayout.fields
    this.runtime.memory.view.setUint32(this.bufferPointer + fields.ptr!.offset, pointer, true)
    this.runtime.memory.view.setUint32(this.bufferPointer + fields.cap!.offset, capacity, true)
    this.runtime.memory.view.setUint32(this.bufferPointer + fields.len!.offset, 0, true)
  }

  private readBufferLength(): number {
    return this.runtime.memory.view.getUint32(
      this.bufferPointer + this.bufferLayout.fields.len!.offset,
      true,
    )
  }

  private readStyle(cells: number): CellStyle {
    const fields = this.styleLayout.fields
    this.runtime.memory.bytes.fill(0, this.stylePointer, this.stylePointer + this.styleLayout.size)
    this.runtime.memory.view.setUint32(
      this.stylePointer + fields.size!.offset,
      this.styleLayout.size,
      true,
    )
    assertGhosttyResult(
      'ghostty_render_state_row_cells_get(STYLE)',
      this.exports.ghostty_render_state_row_cells_get(
        cells,
        RenderStateCellData.Style,
        this.stylePointer,
      ),
    )
    return {
      blink: this.readStyleBoolean('blink'),
      bold: this.readStyleBoolean('bold'),
      faint: this.readStyleBoolean('faint'),
      invisible: this.readStyleBoolean('invisible'),
      inverse: this.readStyleBoolean('inverse'),
      italic: this.readStyleBoolean('italic'),
      overline: this.readStyleBoolean('overline'),
      strikethrough: this.readStyleBoolean('strikethrough'),
      underline: this.runtime.memory.view.getInt32(
        this.stylePointer + fields.underline!.offset,
        true,
      ),
    }
  }

  private readStyleBoolean(name: string): boolean {
    const field = this.styleLayout.fields[name]
    if (!field) {
      throw createGhosttyError('ghostty_type_json', `GhosttyStyle.${name} is missing`)
    }
    return this.runtime.memory.view.getUint8(this.stylePointer + field.offset) !== 0
  }
}

export class GhosttyRenderState {
  private readonly cells: OwnedHandle
  private readonly cellReader: CellReader
  private disposed = false
  private readonly dirtyPointer: number
  private readonly iterator: OwnedHandle
  private readonly runtime: GhosttyRuntime
  private readonly state: OwnedHandle
  private readonly terminal: GhosttyTerminal
  private readonly zeroBooleanPointer: number
  private readonly zeroDirtyPointer: number

  constructor(runtime: GhosttyRuntime, terminal: GhosttyTerminal) {
    this.runtime = runtime
    this.terminal = terminal
    this.state = createOwnedHandle(runtime, 'ghostty_render_state_new', (out) =>
      runtime.exports.ghostty_render_state_new(0, out),
    )
    this.iterator = this.createIterator()
    this.cells = this.createCells()
    this.cellReader = new CellReader(runtime)
    this.dirtyPointer = runtime.memory.allocate(4)
    this.zeroBooleanPointer = runtime.memory.allocate(1)
    this.zeroDirtyPointer = runtime.memory.allocate(4)
  }

  get dirty(): RenderStateDirty {
    this.ensureActive()
    assertGhosttyResult(
      'ghostty_render_state_get(DIRTY)',
      this.runtime.exports.ghostty_render_state_get(
        this.state.handle,
        RenderStateData.Dirty,
        this.dirtyPointer,
      ),
    )
    return this.runtime.memory.view.getInt32(this.dirtyPointer, true) as RenderStateDirty
  }

  update(): RenderStateDirty {
    this.ensureActive()
    assertGhosttyResult(
      'ghostty_render_state_update',
      this.runtime.exports.ghostty_render_state_update(this.state.handle, this.terminal.handle),
    )
    return this.dirty
  }

  snapshot(options: ReadRowsOptions = {}): DamageSnapshot {
    const dirty = this.update()
    return { dirty, rows: this.readRows(options) }
  }

  readRows(options: ReadRowsOptions = {}): readonly RenderRow[] {
    this.ensureActive()
    this.resetIterator()
    const rows: RenderRow[] = []
    let y = 0
    while (this.runtime.exports.ghostty_render_state_row_iterator_next(this.iterator.handle)) {
      const dirty = this.readRowDirty()
      if (options.dirtyOnly && !dirty) {
        y += 1
        continue
      }
      rows.push({ cells: this.readCells(), dirty, y })
      y += 1
    }
    return rows
  }

  acknowledge(): number {
    this.ensureActive()
    this.resetIterator()
    let acknowledgedRows = 0
    while (this.runtime.exports.ghostty_render_state_row_iterator_next(this.iterator.handle)) {
      if (!this.readRowDirty()) continue
      assertGhosttyResult(
        'ghostty_render_state_row_set(DIRTY)',
        this.runtime.exports.ghostty_render_state_row_set(
          this.iterator.handle,
          RenderStateRowOption.Dirty,
          this.zeroBooleanPointer,
        ),
      )
      acknowledgedRows += 1
    }
    assertGhosttyResult(
      'ghostty_render_state_set(DIRTY)',
      this.runtime.exports.ghostty_render_state_set(
        this.state.handle,
        RenderStateOption.Dirty,
        this.zeroDirtyPointer,
      ),
    )
    return acknowledgedRows
  }

  dispose(): void {
    if (this.disposed) return
    this.cellReader.dispose()
    this.runtime.exports.ghostty_render_state_row_cells_free(this.cells.handle)
    this.runtime.exports.ghostty_render_state_row_iterator_free(this.iterator.handle)
    this.runtime.exports.ghostty_render_state_free(this.state.handle)
    this.runtime.memory.freeOpaque(this.cells.out)
    this.runtime.memory.freeOpaque(this.iterator.out)
    this.runtime.memory.freeOpaque(this.state.out)
    this.runtime.memory.free(this.dirtyPointer, 4)
    this.runtime.memory.free(this.zeroBooleanPointer, 1)
    this.runtime.memory.free(this.zeroDirtyPointer, 4)
    this.runtime.releaseRenderState(this)
    this.disposed = true
  }

  private createIterator(): OwnedHandle {
    try {
      return createOwnedHandle(this.runtime, 'ghostty_render_state_row_iterator_new', (out) =>
        this.runtime.exports.ghostty_render_state_row_iterator_new(0, out),
      )
    } catch (cause) {
      this.freeOwnedState()
      throw cause
    }
  }

  private createCells(): OwnedHandle {
    try {
      return createOwnedHandle(this.runtime, 'ghostty_render_state_row_cells_new', (out) =>
        this.runtime.exports.ghostty_render_state_row_cells_new(0, out),
      )
    } catch (cause) {
      this.runtime.exports.ghostty_render_state_row_iterator_free(this.iterator.handle)
      this.runtime.memory.freeOpaque(this.iterator.out)
      this.freeOwnedState()
      throw cause
    }
  }

  private freeOwnedState(): void {
    this.runtime.exports.ghostty_render_state_free(this.state.handle)
    this.runtime.memory.freeOpaque(this.state.out)
  }

  private resetIterator(): void {
    assertGhosttyResult(
      'ghostty_render_state_get(ROW_ITERATOR)',
      this.runtime.exports.ghostty_render_state_get(
        this.state.handle,
        RenderStateData.RowIterator,
        this.iterator.out,
      ),
    )
    this.iterator.handle = this.runtime.memory.readHandle(this.iterator.out)
  }

  private readRowDirty(): boolean {
    assertGhosttyResult(
      'ghostty_render_state_row_get(DIRTY)',
      this.runtime.exports.ghostty_render_state_row_get(
        this.iterator.handle,
        RenderStateRowData.Dirty,
        this.dirtyPointer,
      ),
    )
    return this.runtime.memory.view.getUint8(this.dirtyPointer) !== 0
  }

  private readCells(): readonly RenderCell[] {
    assertGhosttyResult(
      'ghostty_render_state_row_get(CELLS)',
      this.runtime.exports.ghostty_render_state_row_get(
        this.iterator.handle,
        RenderStateRowData.Cells,
        this.cells.out,
      ),
    )
    this.cells.handle = this.runtime.memory.readHandle(this.cells.out)
    const cells: RenderCell[] = []
    let x = 0
    while (this.runtime.exports.ghostty_render_state_row_cells_next(this.cells.handle)) {
      cells.push(this.cellReader.read(this.cells.handle, x))
      x += 1
    }
    return cells
  }

  private ensureActive(): void {
    this.runtime.ensureActive()
    if (!this.disposed) return
    throw createGhosttyError('render_state', 'The render state has been disposed')
  }
}
