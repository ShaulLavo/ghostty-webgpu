import type { WorkerMessage } from '../../src/worker/protocol.js'
import type { RendererTextFrameRow } from '../../src/render/shared/types.js'
import type { TerminalSubmittedRow } from '../../src/dom/submitted-frame.js'
import { freezeWorkerValue } from '../../src/worker/owned.js'

type Frame = Extract<WorkerMessage, { type: 'frame' }>
export interface DeltaFrame extends Omit<Frame, 'snapshot' | 'summary'> {
  readonly snapshot: Omit<Frame['snapshot'], 'rows'>
  readonly summary: Omit<Frame['summary'], 'rows' | 'rowPatches'>
  readonly order: readonly number[]
  readonly ys: readonly number[]
  readonly patches: readonly number[]
  readonly buffer: ArrayBuffer
}

class BinaryWriter {
  private offset = 0
  private readonly view: DataView
  constructor(readonly buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
  }
  number(value: number): void {
    this.view.setUint32(this.offset, value, true)
    this.offset += 4
  }
  text(value: string): void {
    this.number(value.length)
    for (let index = 0; index < value.length; index += 1) {
      this.view.setUint16(this.offset, value.charCodeAt(index), true)
      this.offset += 2
    }
  }
}

class BinaryReader {
  private offset = 0
  private readonly view: DataView
  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
  }
  number(): number {
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }
  text(): string {
    const length = this.number()
    let value = ''
    for (let index = 0; index < length; index += 1) {
      value += String.fromCharCode(this.view.getUint16(this.offset, true))
      this.offset += 2
    }
    return value
  }
}

function movedRow(row: RendererTextFrameRow, y: number): RendererTextFrameRow {
  if (row.y === y) return row
  return freezeWorkerValue({
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

export class RowEncoder {
  private readonly revisions = new Set<number>()
  private previousOrder: readonly number[] = []

  encode(frame: Frame, revisions: readonly number[]): DeltaFrame {
    const rows = frame.snapshot.rows
    if (revisions.length !== rows.length || revisions.some((revision) => revision <= 0))
      throw new Error('native text revisions do not match frame rows')
    const changed = rows.filter((_, index) => !this.revisions.has(revisions[index]!))
    const changedRevisions = revisions.filter((revision) => !this.revisions.has(revision))
    const size = changed.reduce(
      (total, row) =>
        total +
        20 +
        row.text.length * 2 +
        row.cells.reduce((bytes, cell) => bytes + 4 + cell.length * 2, 0) +
        row.continuations.length * 4,
      4,
    )
    const writer = new BinaryWriter(new ArrayBuffer(size))
    writer.number(changed.length)
    for (const [index, row] of changed.entries()) {
      writer.number(changedRevisions[index]!)
      writer.number(row.y)
      writer.text(row.text)
      writer.number(row.cells.length)
      for (const cell of row.cells) writer.text(cell)
      writer.number(row.continuations.length)
      for (const flag of row.continuations) writer.number(Number(flag))
    }
    for (const revision of revisions) this.revisions.add(revision)
    this.prune(revisions)
    const {
      rows: snapshotRows,
      nativeFrame: _nativeFrame,
      ...snapshot
    } = frame.snapshot as Frame['snapshot'] & { nativeFrame?: unknown }
    const { rows: summaryRows, rowPatches, ...summary } = frame.summary
    if (
      summaryRows.length !== snapshotRows.length ||
      summaryRows.some(
        (row, index) => row.y !== snapshotRows[index]?.y || row.text !== snapshotRows[index]?.text,
      )
    )
      throw new Error('summary and renderer rows diverged')
    return {
      ...frame,
      snapshot,
      summary,
      order: revisions,
      ys: snapshotRows.map((row) => row.y),
      patches: rowPatches.map((row) => row.y),
      buffer: writer.buffer,
    }
  }

  private prune(current: readonly number[]): void {
    const keep = new Set(current.concat(this.previousOrder))
    for (const revision of this.revisions) if (!keep.has(revision)) this.revisions.delete(revision)
    this.previousOrder = current
  }
}

export class RowDecoder {
  private readonly rows = new Map<number, RendererTextFrameRow>()
  private readonly textRows = new Map<number, TerminalSubmittedRow>()
  private previousOrder: readonly number[] = []

  decode(frame: DeltaFrame): Frame {
    const reader = new BinaryReader(frame.buffer)
    const count = reader.number()
    for (let index = 0; index < count; index += 1) this.readRow(reader)
    const rows = frame.order.map((revision, index) => this.takeRow(revision, frame.ys[index]!))
    const summaryRows = frame.order.map((revision, index) =>
      this.takeTextRow(revision, frame.ys[index]!),
    )
    const byY = new Map(summaryRows.map((row) => [row.y, row]))
    const rowPatches = frame.patches.map((y) => {
      const row = byY.get(y)
      if (!row) throw new Error(`missing summary patch ${y}`)
      return row
    })
    this.prune(frame.order)
    return {
      ...frame,
      snapshot: { ...frame.snapshot, rows },
      summary: { ...frame.summary, rows: summaryRows, rowPatches },
    }
  }

  private readRow(reader: BinaryReader): void {
    const revision = reader.number()
    const y = reader.number()
    const text = reader.text()
    const cells = Array.from({ length: reader.number() }, () => reader.text())
    const continuations = Array.from({ length: reader.number() }, () => Boolean(reader.number()))
    this.rows.set(revision, freezeWorkerValue({ y, text, cells, continuations }))
    this.textRows.set(revision, Object.freeze({ y, text }))
  }

  private takeRow(revision: number, y: number): RendererTextFrameRow {
    const cached = this.rows.get(revision)
    if (!cached) throw new Error(`missing revision ${revision}`)
    const row = movedRow(cached, y)
    this.rows.set(revision, row)
    return row
  }

  private takeTextRow(revision: number, y: number): TerminalSubmittedRow {
    const cached = this.textRows.get(revision)
    if (!cached) throw new Error(`missing summary revision ${revision}`)
    if (cached.y === y) return cached
    const row = Object.freeze({ y, text: cached.text })
    this.textRows.set(revision, row)
    return row
  }

  private prune(current: readonly number[]): void {
    const keep = new Set(current.concat(this.previousOrder))
    for (const revision of this.rows.keys()) if (!keep.has(revision)) this.rows.delete(revision)
    for (const revision of this.textRows.keys())
      if (!keep.has(revision)) this.textRows.delete(revision)
    this.previousOrder = current
  }
}
