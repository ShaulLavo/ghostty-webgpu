import type { WorkerMessage } from '../../src/worker/protocol.js'
import type { RendererTextFrameRow } from '../../src/render/shared/types.js'
import { freezeWorkerValue } from '../../src/worker/owned.js'

type Frame = Extract<WorkerMessage, { type: 'frame' }>
export interface DeltaFrame extends Omit<Frame, 'snapshot' | 'summary'> {
  readonly snapshot: Omit<Frame['snapshot'], 'rows'>
  readonly summary: Omit<Frame['summary'], 'rows' | 'rowPatches'>
  readonly order: readonly number[]
  readonly patches: readonly number[]
  readonly buffer: ArrayBuffer
}

function equalRow(left: RendererTextFrameRow | undefined, right: RendererTextFrameRow): boolean {
  return (
    left?.text === right.text &&
    left.cells.length === right.cells.length &&
    left.continuations.length === right.continuations.length &&
    left.cells.every((cell, index) => cell === right.cells[index]) &&
    left.continuations.every((flag, index) => flag === right.continuations[index])
  )
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

export class RowEncoder {
  private readonly rows = new Map<number, RendererTextFrameRow>()
  encode(frame: Frame): DeltaFrame {
    const changed = frame.snapshot.rows.filter((row) => !equalRow(this.rows.get(row.y), row))
    const size = changed.reduce(
      (total, row) =>
        total +
        16 +
        row.text.length * 2 +
        row.cells.reduce((bytes, cell) => bytes + 4 + cell.length * 2, 0) +
        row.continuations.length * 4,
      4,
    )
    const writer = new BinaryWriter(new ArrayBuffer(size))
    writer.number(changed.length)
    for (const row of changed) {
      writer.number(row.y)
      writer.text(row.text)
      writer.number(row.cells.length)
      for (const cell of row.cells) writer.text(cell)
      writer.number(row.continuations.length)
      for (const flag of row.continuations) writer.number(Number(flag))
      this.rows.set(row.y, row)
    }
    const { rows, ...snapshot } = frame.snapshot
    const { rows: summaryRows, rowPatches, ...summary } = frame.summary
    if (
      summaryRows.length !== rows.length ||
      summaryRows.some((row, index) => row.y !== rows[index]?.y || row.text !== rows[index]?.text)
    )
      throw new Error('summary and renderer rows diverged')
    return {
      ...frame,
      snapshot,
      summary,
      order: rows.map((row) => row.y),
      patches: rowPatches.map((row) => row.y),
      buffer: writer.buffer,
    }
  }
}

export class RowDecoder {
  private readonly rows = new Map<number, RendererTextFrameRow>()
  private readonly textRows = new Map<number, { readonly y: number; readonly text: string }>()
  decode(frame: DeltaFrame): Frame {
    const reader = new BinaryReader(frame.buffer)
    const count = reader.number()
    for (let index = 0; index < count; index += 1) {
      const y = reader.number()
      const text = reader.text()
      const cells = Array.from({ length: reader.number() }, () => reader.text())
      const continuations = Array.from({ length: reader.number() }, () => Boolean(reader.number()))
      this.rows.set(y, freezeWorkerValue({ y, text, cells, continuations }))
      this.textRows.set(y, Object.freeze({ y, text }))
    }
    const rows = frame.order.map((y) => {
      const row = this.rows.get(y)
      if (!row) throw new Error(`missing binary row ${y}`)
      return row
    })
    const textRow = (y: number) => {
      const row = this.textRows.get(y)
      if (!row) throw new Error(`missing summary row ${y}`)
      return row
    }
    return {
      ...frame,
      snapshot: { ...frame.snapshot, rows },
      summary: {
        ...frame.summary,
        rows: frame.order.map(textRow),
        rowPatches: frame.patches.map(textRow),
      },
    }
  }
}
