import {
  RenderStateCursorVisualStyle,
  RenderStateData,
  RenderStateDirty,
  RenderStateOption,
  RenderStateRowData,
  RenderStateRowOption,
} from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import { requireLayout } from './memory.js'
import { ZigFrameBuilder } from './zig-frame.js'
import { DisplayedFrameStore } from './displayed-frame.js'
import { retainDisplayedFrame } from '../render/displayed-frame.js'
import { RowReader } from './row-reader.js'
import { TextRowReader } from './text-row-reader.js'
import type { GhosttyRuntime } from './runtime.js'
import type { GhosttyTerminal } from './terminal.js'
import type {
  DamageSnapshot,
  ReadRowsOptions,
  ReadTextRowsOptions,
  RenderCursorSnapshot,
  RenderRow,
  RenderTextRow,
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

export class GhosttyRenderState {
  private displayedFrames?: DisplayedFrameStore
  private readonly cells: OwnedHandle
  private readonly rowReader: RowReader
  private readonly textRowReader: TextRowReader
  private readonly cursorReader: CursorReader
  private cursorSnapshot?: RenderCursorSnapshot
  private snapshotRevision = 0
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
    let rowReader: RowReader | undefined
    let cursorReader: CursorReader | undefined
    let scalarPointer = 0
    try {
      rowReader = new RowReader(runtime)
      cursorReader = new CursorReader(runtime)
      scalarPointer = runtime.memory.allocate(12)
    } catch (cause) {
      if (scalarPointer !== 0) runtime.memory.free(scalarPointer, 12)
      cursorReader?.dispose()
      rowReader?.dispose()
      this.freeNativeHandles()
      throw cause
    }
    this.rowReader = rowReader
    this.textRowReader = new TextRowReader(runtime)
    this.cursorReader = cursorReader
    this.scalarPointer = scalarPointer
    this.dirtyPointer = scalarPointer
    this.zeroBooleanPointer = scalarPointer + 4
    this.zeroDirtyPointer = scalarPointer + 8
  }

  /** Advances on damaged updates, independently of whether the renderer paints them. */
  get snapshotVersion(): number {
    return this.snapshotRevision
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
    if (snapshot.dirty !== RenderStateDirty.False) this.snapshotRevision += 1
    return snapshot.dirty
  }

  createFrameBuilder(columns: number, rows: number): ZigFrameBuilder {
    this.ensureActive()
    return new ZigFrameBuilder(
      this.runtime,
      this.state.handle,
      this.iterator.handle,
      this.cells.handle,
      columns,
      rows,
      () => this.ensureActive(),
    )
  }

  snapshot(options: ReadRowsOptions = {}): DamageSnapshot {
    const dirty = this.update()
    return { dirty, rows: this.readRows(options) }
  }

  readRows(options: ReadRowsOptions = {}): readonly RenderRow[] {
    this.ensureActive()
    return this.rowReader.read(
      this.state.handle,
      this.iterator.handle,
      this.cells.handle,
      this.readGrid(),
      options,
    )
  }

  /** Reads the last updated state without updating or acknowledging damage. */
  readTextRows(options: ReadTextRowsOptions = {}): readonly RenderTextRow[] {
    this.ensureActive()
    return this.textRowReader.read(
      this.state.handle,
      this.iterator.handle,
      this.cells.handle,
      this.readGrid(),
      options,
    )
  }

  [retainDisplayedFrame](options: { full?: boolean } = {}) {
    this.ensureActive()
    this.displayedFrames ??= new DisplayedFrameStore(this.runtime)
    return this.displayedFrames.capture(
      this.state.handle,
      this.iterator.handle,
      this.cells.handle,
      this.readGrid(),
      options.full,
    )
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
    this.displayedFrames?.dispose()
    this.cursorReader.dispose()
    this.rowReader.dispose()
    this.textRowReader.dispose()
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

  private readGrid(): { columns: number; rows: number } {
    assertGhosttyResult(
      'ghostty_render_state_get(COLUMNS)',
      this.runtime.exports.ghostty_render_state_get(
        this.state.handle,
        RenderStateData.Columns,
        this.dirtyPointer,
      ),
    )
    const columns = this.runtime.memory.view.getUint16(this.dirtyPointer, true)
    assertGhosttyResult(
      'ghostty_render_state_get(ROWS)',
      this.runtime.exports.ghostty_render_state_get(
        this.state.handle,
        RenderStateData.Rows,
        this.dirtyPointer,
      ),
    )
    return { columns, rows: this.runtime.memory.view.getUint16(this.dirtyPointer, true) }
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

  private ensureActive(): void {
    this.runtime.ensureActive()
    if (!this.disposed) return
    throw createGhosttyError('render_state', 'The render state has been disposed')
  }
}
