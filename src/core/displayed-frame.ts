import { assertGhosttyResult, createGhosttyError } from './error.js'
import { RowReader } from './row-reader.js'
import { TextRowReader } from './text-row-reader.js'
import type { GhosttyRuntime } from './runtime.js'
import type { ReadRowsOptions, ReadTextRowsOptions, RenderRow, RenderTextRow } from './types.js'

type DisplayedRowsOptions = Pick<ReadRowsOptions, 'rows' | 'packed'>
type DisplayedTextOptions = Pick<ReadTextRowsOptions, 'rows'>

export interface NativeDisplayedFrame {
  readonly token: number
  accept(): void
  discard(): void
  readRows(options?: DisplayedRowsOptions): readonly RenderRow[]
  readTextRows(options?: DisplayedTextOptions): readonly RenderTextRow[]
  readPreviousTextRows(): readonly RenderTextRow[]
}

interface NativeSlot {
  readonly handle: number
  readonly columns: number
  readonly rows: number
}

interface PackedDescriptor {
  readonly bits: Record<string, { readonly lsb: number; readonly width: number }>
}

interface DisplayedFrames {
  current?: NativeSlot
  previous?: NativeSlot
  spare?: NativeSlot
  pending?: NativeSlot
  disposed: boolean
  currentToken: number
  pendingToken: number
  readonly rowReader: RowReader
  readonly textReader: TextRowReader
  readonly previousReader: TextRowReader
}

const noOptions = Object.freeze({})
const emptyTextRows: readonly RenderTextRow[] = Object.freeze([])

class DisplayedFrame implements NativeDisplayedFrame {
  #rows: readonly RenderTextRow[] | undefined
  #previousRows: readonly RenderTextRow[] | undefined

  constructor(
    private readonly frames: DisplayedFrames,
    private readonly current: NativeSlot,
    private readonly previous: NativeSlot | undefined,
    readonly token: number,
  ) {}

  accept(): void {
    if (!this.pending()) return
    const frames = this.frames
    frames.pending = undefined
    frames.spare = frames.previous
    frames.previous = frames.current
    frames.current = this.current
    frames.currentToken = this.token
  }

  discard(): void {
    if (this.pending()) this.frames.pending = undefined
  }

  readRows(options: DisplayedRowsOptions = noOptions): readonly RenderRow[] {
    this.active()
    return this.frames.rowReader.read(this.current.handle, 0, 0, this.current, options)
  }

  readTextRows(options: DisplayedTextOptions = noOptions): readonly RenderTextRow[] {
    this.active()
    if (options.rows)
      return this.frames.textReader.read(this.current.handle, 0, 0, this.current, options)
    return (this.#rows ??= this.frames.textReader.read(
      this.current.handle,
      0,
      0,
      this.current,
      options,
    ))
  }

  readPreviousTextRows(): readonly RenderTextRow[] {
    this.active()
    if (!this.previous) return emptyTextRows
    return (this.#previousRows ??= this.frames.previousReader.read(
      this.previous.handle,
      0,
      0,
      this.previous,
      noOptions,
    ))
  }

  private pending(): boolean {
    return this.frames.pending === this.current && this.frames.pendingToken === this.token
  }

  private active(): void {
    const frames = this.frames
    if (
      frames.disposed ||
      (!this.pending() && (frames.current !== this.current || frames.currentToken !== this.token))
    )
      throw createGhosttyError('read_displayed_frame', 'Displayed-frame token has retired')
  }
}

export class DisplayedFrameStore {
  private token = 0
  private readonly frames: DisplayedFrames

  constructor(private readonly runtime: GhosttyRuntime) {
    this.frames = {
      disposed: false,
      currentToken: 0,
      pendingToken: 0,
      rowReader: new RowReader(runtime, (...args) => runtime.bridge.readRetainedRows(...args)),
      textReader: new TextRowReader(runtime, (...args) => runtime.bridge.readRetainedText(...args)),
      previousReader: new TextRowReader(runtime, (...args) =>
        runtime.bridge.readRetainedText(...args),
      ),
    }
  }

  capture(
    state: number,
    iterator: number,
    cells: number,
    grid: { columns: number; rows: number },
    full = false,
  ): NativeDisplayedFrame {
    const frames = this.frames
    if (frames.disposed)
      throw createGhosttyError('retain_frame', 'Displayed-frame store is disposed')
    if (frames.pending)
      throw createGhosttyError('retain_frame', 'A displayed-frame capture is awaiting acceptance')
    const descriptor = this.runtime.layouts.GhosttyCell as unknown as PackedDescriptor
    const tag = descriptor.bits.content_tag
    const style = descriptor.bits.style_id
    if (!tag || tag.width !== 2 || !style || style.width < 1 || style.width > 32)
      throw createGhosttyError('retain_frame', 'Native cell layout cannot be retained')
    let next = frames.spare
    if (!next || next.columns !== grid.columns || next.rows !== grid.rows) {
      const handle = this.runtime.bridge.createRetainedFrame(grid.columns, grid.rows)
      if (!handle)
        throw createGhosttyError('retain_frame', 'Native displayed-frame allocation failed')
      next = { handle, ...grid }
    }
    try {
      assertGhosttyResult(
        'retain_frame',
        this.runtime.bridge.captureRetainedFrame(
          next.handle,
          frames.current?.handle ?? 0,
          Number(full),
          state,
          iterator,
          cells,
          tag.lsb,
          style.lsb,
          style.width,
        ),
      )
    } catch (cause) {
      if (next !== frames.spare) this.runtime.bridge.destroyRetainedFrame(next.handle)
      throw cause
    }
    if (frames.spare && next !== frames.spare)
      this.runtime.bridge.destroyRetainedFrame(frames.spare.handle)
    frames.spare = next
    frames.pending = next
    const token = ++this.token
    frames.pendingToken = token
    return Object.freeze(new DisplayedFrame(frames, next, frames.current, token))
  }

  dispose(): void {
    const frames = this.frames
    if (frames.disposed) return
    frames.disposed = true
    this.token += 1
    if (frames.current) this.runtime.bridge.destroyRetainedFrame(frames.current.handle)
    if (frames.previous) this.runtime.bridge.destroyRetainedFrame(frames.previous.handle)
    if (frames.spare) this.runtime.bridge.destroyRetainedFrame(frames.spare.handle)
    frames.pending = undefined
    frames.spare = undefined
    frames.current = undefined
    frames.previous = undefined
    frames.rowReader.dispose()
    frames.textReader.dispose()
    frames.previousReader.dispose()
  }
}
