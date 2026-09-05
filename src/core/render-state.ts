import {
  CellData,
  CellWide,
  GhosttyResult,
  RenderStateCellData,
  RenderStateCursorVisualStyle,
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
  RenderCursorSnapshot,
  RenderRow,
  RgbColor,
} from './types.js'

interface OwnedHandle {
  handle: number
  out: number
}

const renderSnapshotFieldCount = 2
const renderSnapshotKeysOffset = 0
const renderSnapshotValuesOffset = 8
const renderSnapshotWrittenOffset = 16
const renderSnapshotDirtyOffset = 20
const renderSnapshotCursorOffset = 24

function cursorStyle(value: number): RenderCursorSnapshot['style'] {
  if (value === RenderStateCursorVisualStyle.Bar) return 'bar'
  if (value === RenderStateCursorVisualStyle.Block) return 'block'
  if (value === RenderStateCursorVisualStyle.Underline) return 'underline'
  if (value === RenderStateCursorVisualStyle.BlockHollow) return 'outline'
  throw createGhosttyError('ghostty_render_state_get_multi', `Unknown cursor style: ${value}`)
}

class CursorReader {
  private readonly buffer: number
  private readonly bufferSize: number
  private readonly cursorLayout
  private readonly runtime: GhosttyRuntime

  constructor(runtime: GhosttyRuntime) {
    this.runtime = runtime
    this.cursorLayout = requireLayout(runtime.layouts, 'GhosttyRenderStateCursor')
    this.bufferSize = renderSnapshotCursorOffset + this.cursorLayout.size
    this.buffer = runtime.memory.allocate(this.bufferSize)
    const view = runtime.memory.view
    view.setInt32(this.buffer + renderSnapshotKeysOffset, RenderStateData.Dirty, true)
    view.setInt32(this.buffer + renderSnapshotKeysOffset + 4, RenderStateData.Cursor, true)
    view.setUint32(
      this.buffer + renderSnapshotValuesOffset,
      this.buffer + renderSnapshotDirtyOffset,
      true,
    )
    view.setUint32(
      this.buffer + renderSnapshotValuesOffset + 4,
      this.buffer + renderSnapshotCursorOffset,
      true,
    )
  }

  read(state: number): { cursor: RenderCursorSnapshot; dirty: RenderStateDirty } {
    const view = this.runtime.memory.view
    const cursor = this.buffer + renderSnapshotCursorOffset
    this.runtime.memory.bytes.fill(0, cursor, cursor + this.cursorLayout.size)
    view.setUint32(cursor + this.cursorLayout.fields.size!.offset, this.cursorLayout.size, true)
    view.setUint32(this.buffer + renderSnapshotWrittenOffset, 0, true)
    assertGhosttyResult(
      'ghostty_render_state_get_multi(DIRTY,CURSOR)',
      this.runtime.exports.ghostty_render_state_get_multi(
        state,
        renderSnapshotFieldCount,
        this.buffer + renderSnapshotKeysOffset,
        this.buffer + renderSnapshotValuesOffset,
        this.buffer + renderSnapshotWrittenOffset,
      ),
    )
    const written = view.getUint32(this.buffer + renderSnapshotWrittenOffset, true)
    if (written !== renderSnapshotFieldCount) {
      throw createGhosttyError(
        'ghostty_render_state_get_multi',
        `Render snapshot wrote ${written} of ${renderSnapshotFieldCount} fields`,
      )
    }
    const fields = this.cursorLayout.fields
    const viewportPresent = view.getUint8(cursor + fields.viewport_has_value!.offset) !== 0
    const snapshot: RenderCursorSnapshot = {
      blinking: view.getUint8(cursor + fields.blinking!.offset) !== 0,
      passwordInput: view.getUint8(cursor + fields.password_input!.offset) !== 0,
      style: cursorStyle(view.getInt32(cursor + fields.visual_style!.offset, true)),
      visible: view.getUint8(cursor + fields.visible!.offset) !== 0,
    }
    if (viewportPresent) {
      snapshot.viewport = {
        wideTail: view.getUint8(cursor + fields.wide_tail!.offset) !== 0,
        x: view.getUint16(cursor + fields.viewport_x!.offset, true),
        y: view.getUint16(cursor + fields.viewport_y!.offset, true),
      }
    }
    return {
      cursor: snapshot,
      dirty: view.getInt32(this.buffer + renderSnapshotDirtyOffset, true) as RenderStateDirty,
    }
  }

  dispose(): void {
    this.runtime.memory.free(this.buffer, this.bufferSize)
  }
}

function copyCursor(cursor: RenderCursorSnapshot): RenderCursorSnapshot {
  return {
    blinking: cursor.blinking,
    passwordInput: cursor.passwordInput,
    style: cursor.style,
    viewport: cursor.viewport ? { ...cursor.viewport } : undefined,
    visible: cursor.visible,
  }
}

function alignOffset(offset: number, alignment: number): number {
  return Math.ceil(offset / alignment) * alignment
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
  private readonly rawCellPointer: number
  private readonly runtime: GhosttyRuntime
  private readonly storagePointer: number
  private readonly storageSize: number
  private readonly styleLayout
  private readonly stylePointer: number
  private readonly textCapacity = 64
  private readonly textPointer: number
  private readonly widePointer: number

  constructor(runtime: GhosttyRuntime) {
    this.runtime = runtime
    this.bufferLayout = requireLayout(runtime.layouts, 'GhosttyBuffer')
    this.styleLayout = requireLayout(runtime.layouts, 'GhosttyStyle')
    const boolOffset = 0
    const rawCellOffset = alignOffset(boolOffset + 1, 8)
    const wideOffset = rawCellOffset + 8
    const bufferOffset = alignOffset(wideOffset + 4, this.bufferLayout.align)
    const colorOffset = bufferOffset + this.bufferLayout.size
    const styleOffset = alignOffset(colorOffset + 3, this.styleLayout.align)
    const textOffset = styleOffset + this.styleLayout.size
    this.storageSize = textOffset + this.textCapacity
    this.storagePointer = runtime.memory.allocate(this.storageSize)
    this.boolPointer = this.storagePointer + boolOffset
    this.rawCellPointer = this.storagePointer + rawCellOffset
    this.widePointer = this.storagePointer + wideOffset
    this.bufferPointer = this.storagePointer + bufferOffset
    this.colorPointer = this.storagePointer + colorOffset
    this.stylePointer = this.storagePointer + styleOffset
    this.textPointer = this.storagePointer + textOffset
  }

  read(cells: number, x: number): RenderCell {
    const hasStyling = this.readBoolean(cells, RenderStateCellData.HasStyling)
    return {
      background: this.readColor(cells, RenderStateCellData.BackgroundColor),
      continuation: this.readWide(cells) === CellWide.SpacerTail,
      foreground: this.readColor(cells, RenderStateCellData.ForegroundColor),
      selected: this.readBoolean(cells, RenderStateCellData.Selected),
      style: hasStyling ? this.readStyle(cells) : undefined,
      text: this.readText(cells),
      x,
    }
  }

  dispose(): void {
    this.runtime.memory.free(this.storagePointer, this.storageSize)
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

  private readWide(cells: number): CellWide {
    assertGhosttyResult(
      'ghostty_render_state_row_cells_get(RAW)',
      this.exports.ghostty_render_state_row_cells_get(
        cells,
        RenderStateCellData.Raw,
        this.rawCellPointer,
      ),
    )
    const cell = this.runtime.memory.view.getBigUint64(this.rawCellPointer, true)
    assertGhosttyResult(
      'ghostty_cell_get(WIDE)',
      this.exports.ghostty_cell_get(cell, CellData.Wide, this.widePointer),
    )
    return this.runtime.memory.view.getInt32(this.widePointer, true) as CellWide
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
  private readonly cursorReader: CursorReader
  private cursorSnapshot?: RenderCursorSnapshot
  private disposed = false
  private readonly dirtyPointer: number
  private readonly iterator: OwnedHandle
  private readonly runtime: GhosttyRuntime
  private readonly scalarPointer: number
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
    let cellReader: CellReader | undefined
    let cursorReader: CursorReader | undefined
    let scalarPointer = 0
    try {
      cellReader = new CellReader(runtime)
      cursorReader = new CursorReader(runtime)
      scalarPointer = runtime.memory.allocate(12)
    } catch (cause) {
      if (scalarPointer !== 0) runtime.memory.free(scalarPointer, 12)
      cursorReader?.dispose()
      cellReader?.dispose()
      this.freeNativeHandles()
      throw cause
    }
    this.cellReader = cellReader
    this.cursorReader = cursorReader
    this.scalarPointer = scalarPointer
    this.dirtyPointer = scalarPointer
    this.zeroBooleanPointer = scalarPointer + 4
    this.zeroDirtyPointer = scalarPointer + 8
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
    const snapshot = this.cursorReader.read(this.state.handle)
    this.cursorSnapshot = snapshot.cursor
    return snapshot.dirty
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
      const row = y++
      if (options.rows && !options.rows.has(row)) continue
      const dirty = this.readRowDirty()
      if (options.dirtyOnly && !dirty) continue
      rows.push({ cells: this.readCells(), dirty, y: row })
    }
    return rows
  }

  readCursor(): RenderCursorSnapshot {
    this.ensureActive()
    if (!this.cursorSnapshot) this.update()
    return copyCursor(this.cursorSnapshot!)
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
    this.cursorReader.dispose()
    this.cellReader.dispose()
    this.runtime.memory.free(this.scalarPointer, 12)
    this.freeNativeHandles()
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

  private freeNativeHandles(): void {
    this.runtime.exports.ghostty_render_state_row_cells_free(this.cells.handle)
    this.runtime.exports.ghostty_render_state_row_iterator_free(this.iterator.handle)
    this.runtime.exports.ghostty_render_state_free(this.state.handle)
    this.runtime.memory.freeOpaque(this.cells.out)
    this.runtime.memory.freeOpaque(this.iterator.out)
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
