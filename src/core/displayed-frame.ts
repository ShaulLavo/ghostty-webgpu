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

interface CachedTextRow {
  readonly revision: number
  readonly row: RenderTextRow
}

// Three slots rotate, so a row revision can be wanted by at most three frames.
const cachedRevisionsPerRow = 3

/** Text rows memoized by native row revision; copied rows keep their revision. */
class RevisionTextCache {
  private rows: CachedTextRow[][] = []
  private revisions = 0
  private revisionsSize = 0
  extractedRows = 0

  constructor(
    private readonly runtime: GhosttyRuntime,
    private readonly reader: TextRowReader,
  ) {}

  read(slot: NativeSlot): readonly RenderTextRow[] {
    const revisions = this.readRevisions(slot)
    const result: RenderTextRow[] = Array.from({ length: slot.rows })
    const missing = new Set<number>()
    for (let y = 0; y < slot.rows; y += 1) {
      const revision = revisions[y]!
      const cached =
        revision === 0 ? undefined : this.rows[y]?.find((entry) => entry.revision === revision)
      if (cached) result[y] = cached.row
      else missing.add(y)
    }
    if (missing.size > 0) this.extract(slot, missing, revisions, result)
    return Object.freeze(result)
  }

  private extract(
    slot: NativeSlot,
    missing: ReadonlySet<number>,
    revisions: readonly number[],
    result: RenderTextRow[],
  ): void {
    const options = missing.size === slot.rows ? noOptions : { rows: missing }
    for (const row of this.reader.read(slot.handle, 0, 0, slot, options)) {
      result[row.y] = row
      this.remember(row, revisions[row.y]!)
    }
    this.extractedRows += missing.size
  }

  private remember(row: RenderTextRow, revision: number): void {
    if (revision === 0) return
    const entries = (this.rows[row.y] ??= [])
    entries.push({ revision, row })
    if (entries.length > cachedRevisionsPerRow) entries.shift()
  }

  private readRevisions(slot: NativeSlot): number[] {
    const size = slot.rows * 4
    if (size > this.revisionsSize) {
      if (this.revisions !== 0) this.runtime.memory.free(this.revisions, this.revisionsSize)
      this.revisions = this.runtime.memory.allocate(size)
      this.revisionsSize = size
    }
    this.runtime.bridge.readRetainedRevisions(slot.handle, this.revisions)
    return Array.from(
      new Uint32Array(this.runtime.exports.memory.buffer, this.revisions, slot.rows),
    )
  }

  dispose(): void {
    if (this.revisions !== 0) this.runtime.memory.free(this.revisions, this.revisionsSize)
    this.revisions = 0
    this.rows = []
  }
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
  readonly textCache: RevisionTextCache
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
    return (this.#rows ??= this.frames.textCache.read(this.current))
  }

  readPreviousTextRows(): readonly RenderTextRow[] {
    this.active()
    if (!this.previous) return emptyTextRows
    return (this.#previousRows ??= this.frames.textCache.read(this.previous))
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
  get extractedTextRows(): number {
    return this.frames.textCache.extractedRows
  }

  private token = 0
  private readonly frames: DisplayedFrames

  constructor(private readonly runtime: GhosttyRuntime) {
    const textReader = new TextRowReader(runtime, (...args) =>
      runtime.bridge.readRetainedText(...args),
    )
    this.frames = {
      disposed: false,
      currentToken: 0,
      pendingToken: 0,
      rowReader: new RowReader(runtime, (...args) => runtime.bridge.readRetainedRows(...args)),
      textReader,
      textCache: new RevisionTextCache(runtime, textReader),
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
    frames.textCache.dispose()
  }
}
