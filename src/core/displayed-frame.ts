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

interface PendingCapture {
  readonly history: DisplayedHistory
  readonly token: number
  readonly insertedRevisions: Set<number>
}

interface PackedDescriptor {
  readonly bits: Record<string, { readonly lsb: number; readonly width: number }>
}

function movedRow(row: RenderTextRow, y: number): RenderTextRow {
  if (row.y === y) return row
  return Object.freeze({
    y,
    text: row.text,
    get cells() {
      return row.cells
    },
    get continuations() {
      return row.continuations
    },
  })
}

/** Text rows shared by the readable native slots of one subscriber. */
class RevisionTextCache {
  observed = false
  private readonly rows = new Map<number, RenderTextRow>()
  private readonly slotRevisions = new Map<NativeSlot, readonly number[]>()
  private revisions = 0
  private revisionsSize = 0

  constructor(
    private readonly runtime: GhosttyRuntime,
    private readonly reader: TextRowReader,
  ) {}

  read(
    slot: NativeSlot,
    readable: readonly (NativeSlot | undefined)[],
    inserted?: Set<number>,
  ): readonly RenderTextRow[] {
    this.observed = true
    const revisions = this.readRevisions(slot)
    const result: RenderTextRow[] = Array.from({ length: slot.rows })
    const missing = new Set<number>()
    for (let y = 0; y < slot.rows; y += 1) {
      const cached = this.take(revisions[y]!)
      if (cached) result[y] = movedRow(cached, y)
      else missing.add(y)
    }
    if (missing.size > 0) this.extract(slot, missing, revisions, result, inserted)
    this.prune(readable)
    return Object.freeze(result)
  }

  discard(pending: PendingCapture): void {
    for (const revision of pending.insertedRevisions) this.rows.delete(revision)
    const slot = pending.history.slot
    if (slot) this.slotRevisions.delete(slot)
  }

  private take(revision: number): RenderTextRow | undefined {
    if (revision === 0) return undefined
    return this.rows.get(revision)
  }

  private extract(
    slot: NativeSlot,
    missing: ReadonlySet<number>,
    revisions: readonly number[],
    result: RenderTextRow[],
    inserted: Set<number> | undefined,
  ): void {
    const options = missing.size === slot.rows ? noOptions : { rows: missing }
    for (const row of this.reader.read(slot.handle, 0, 0, slot, options)) {
      result[row.y] = row
      const revision = revisions[row.y]!
      if (revision === 0 || this.rows.has(revision)) continue
      this.rows.set(revision, row)
      inserted?.add(revision)
    }
  }

  private prune(readable: readonly (NativeSlot | undefined)[]): void {
    for (const slot of readable) if (slot) this.readRevisions(slot)
    this.retire(readable)
  }

  retire(readable: readonly (NativeSlot | undefined)[]): void {
    if (this.slotRevisions.size === 0) return
    const keep = new Set<number>()
    for (const slot of readable) {
      if (!slot) continue
      for (const revision of this.slotRevisions.get(slot) ?? []) keep.add(revision)
    }
    for (const revision of this.rows.keys()) if (!keep.has(revision)) this.rows.delete(revision)
    for (const slot of this.slotRevisions.keys())
      if (!readable.includes(slot)) this.slotRevisions.delete(slot)
  }

  rowRevisions(slot: NativeSlot): readonly number[] {
    return this.slotRevisions.get(slot) ?? this.readRevisions(slot)
  }

  private readRevisions(slot: NativeSlot): number[] {
    const size = slot.rows * Float64Array.BYTES_PER_ELEMENT
    if (size > this.revisionsSize) {
      const revisions = this.runtime.memory.allocate(size)
      if (this.revisions !== 0) this.runtime.memory.free(this.revisions, this.revisionsSize)
      this.revisions = revisions
      this.revisionsSize = size
    }
    this.runtime.bridge.readRetainedRevisions(slot.handle, this.revisions)
    const revisions = Array.from(
      new Float64Array(this.runtime.exports.memory.buffer, this.revisions, slot.rows),
    )
    this.slotRevisions.set(slot, revisions)
    return revisions
  }

  dispose(): void {
    if (this.revisions !== 0) this.runtime.memory.free(this.revisions, this.revisionsSize)
    this.revisions = 0
    this.rows.clear()
    this.slotRevisions.clear()
  }
}

type HistoryContent =
  | { kind: 'native'; slot: NativeSlot; rows?: readonly RenderTextRow[] }
  | { kind: 'owned'; rows: readonly RenderTextRow[]; revisions: readonly number[] }
  | { kind: 'retired' }

class DisplayedHistory {
  private content: HistoryContent

  constructor(slot: NativeSlot) {
    this.content = { kind: 'native', slot }
  }

  get slot(): NativeSlot | undefined {
    return this.content.kind === 'native' ? this.content.slot : undefined
  }

  native(): NativeSlot {
    const slot = this.slot
    if (!slot)
      throw createGhosttyError('read_displayed_frame', 'Displayed-frame history has retired')
    return slot
  }

  read(
    cache: RevisionTextCache,
    readable: readonly (NativeSlot | undefined)[],
    inserted?: Set<number>,
  ): readonly RenderTextRow[] {
    const content = this.content
    if (content.kind === 'owned') return content.rows
    if (content.kind === 'retired')
      throw createGhosttyError('read_displayed_frame', 'Displayed-frame history has retired')
    return (content.rows ??= cache.read(content.slot, readable, inserted))
  }

  materialize(
    cache: RevisionTextCache,
    readable: readonly (NativeSlot | undefined)[],
  ): NativeSlot | undefined {
    const slot = this.slot
    if (!slot) return undefined
    const rows = this.read(cache, readable)
    const revisions = cache.rowRevisions(slot)
    this.content = { kind: 'owned', rows, revisions }
    return slot
  }

  retire(): void {
    this.content = { kind: 'retired' }
  }
}

interface DisplayedFrames {
  current?: DisplayedHistory
  previous?: DisplayedHistory
  spare?: NativeSlot
  pending?: PendingCapture
  disposed: boolean
  currentToken: number
  readonly rowReader: RowReader
  readonly textReader: TextRowReader
  readonly textCache: RevisionTextCache
}

const noOptions = Object.freeze({})
const emptyTextRows: readonly RenderTextRow[] = Object.freeze([])

function readableSlots(frames: DisplayedFrames): readonly (NativeSlot | undefined)[] {
  return [frames.current?.slot, frames.previous?.slot, frames.pending?.history.slot]
}

class DisplayedFrame implements NativeDisplayedFrame {
  constructor(
    private readonly frames: DisplayedFrames,
    private readonly current: DisplayedHistory,
    private readonly previous: DisplayedHistory | undefined,
    readonly token: number,
  ) {}

  accept(): void {
    if (!this.pending()) return
    const frames = this.frames
    frames.pending = undefined
    frames.previous?.retire()
    frames.spare = undefined
    frames.previous = frames.current
    frames.current = this.current
    frames.currentToken = this.token
    frames.textCache.retire(readableSlots(frames))
  }

  discard(): void {
    const pending = this.pending()
    if (!pending) return
    this.frames.pending = undefined
    this.frames.textCache.discard(pending)
    pending.history.retire()
  }

  readRows(options: DisplayedRowsOptions = noOptions): readonly RenderRow[] {
    this.active()
    const slot = this.current.native()
    return this.frames.rowReader.read(slot.handle, 0, 0, slot, options)
  }

  readTextRows(options: DisplayedTextOptions = noOptions): readonly RenderTextRow[] {
    this.active()
    if (options.rows) {
      this.frames.textCache.observed = true
      const slot = this.current.native()
      return this.frames.textReader.read(slot.handle, 0, 0, slot, options)
    }
    return this.current.read(
      this.frames.textCache,
      readableSlots(this.frames),
      this.pending()?.insertedRevisions,
    )
  }

  readPreviousTextRows(): readonly RenderTextRow[] {
    this.active()
    if (!this.previous) return emptyTextRows
    return this.previous.read(this.frames.textCache, readableSlots(this.frames))
  }

  private pending(): PendingCapture | undefined {
    const pending = this.frames.pending
    if (!pending || pending.history !== this.current || pending.token !== this.token)
      return undefined
    return pending
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
    const textReader = new TextRowReader(
      runtime,
      (...args) => runtime.bridge.readRetainedText(...args),
      'row',
    )
    this.frames = {
      disposed: false,
      currentToken: 0,
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
    if (!frames.spare && frames.previous) {
      const recycled = frames.previous.materialize(frames.textCache, readableSlots(frames))
      if (recycled) frames.spare = recycled
    }
    let next = frames.spare
    if (next && (next.columns !== grid.columns || next.rows !== grid.rows)) {
      this.runtime.bridge.destroyRetainedFrame(next.handle)
      frames.spare = undefined
      next = undefined
    }
    if (!next) {
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
          frames.current?.native().handle ?? 0,
          Number(full),
          state,
          iterator,
          cells,
          tag.lsb,
          style.lsb,
          style.width,
          Number(frames.textCache.observed),
        ),
      )
    } catch (cause) {
      if (next !== frames.spare) this.runtime.bridge.destroyRetainedFrame(next.handle)
      throw cause
    }
    if (frames.spare && next !== frames.spare)
      this.runtime.bridge.destroyRetainedFrame(frames.spare.handle)
    // Each capture has its own descriptor because native handles are recycled.
    const captured = { ...next }
    const token = ++this.token
    const history = new DisplayedHistory(captured)
    frames.spare = captured
    frames.pending = { history, token, insertedRevisions: new Set() }
    return Object.freeze(new DisplayedFrame(frames, history, frames.current, token))
  }

  dispose(): void {
    const frames = this.frames
    if (frames.disposed) return
    frames.disposed = true
    this.token += 1
    for (const slot of [frames.current?.slot, frames.previous?.slot, frames.spare])
      if (slot) this.runtime.bridge.destroyRetainedFrame(slot.handle)
    frames.current?.retire()
    frames.previous?.retire()
    frames.pending?.history.retire()
    frames.pending = undefined
    frames.spare = undefined
    frames.current = undefined
    frames.previous = undefined
    frames.rowReader.dispose()
    frames.textReader.dispose()
    frames.textCache.dispose()
  }
}
