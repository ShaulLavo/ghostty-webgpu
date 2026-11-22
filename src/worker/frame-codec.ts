import type { TerminalSubmittedRow } from '../dom/submitted-frame.js'
import type { RendererTextFrameRow } from '../render/shared/types.js'
import { freezeWorkerValue } from './owned.js'
import type { WorkerFrameDelta, WorkerSubmission } from './protocol.js'

const uint32Bytes = 4
const codeUnitBytes = 2
const rowHeaderBytes = 4 * uint32Bytes
const codeUnitChunk = 4096
const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1

function equalRow(left: RendererTextFrameRow | undefined, right: RendererTextFrameRow): boolean {
  if (left === right) return true
  if (!left || left.text !== right.text) return false
  const leftCells = left.cells
  const rightCells = right.cells
  if (leftCells.length !== rightCells.length) return false
  for (let index = 0; index < leftCells.length; index++) {
    if (leftCells[index] !== rightCells[index]) return false
  }
  const leftFlags = left.continuations
  const rightFlags = right.continuations
  if (leftFlags.length !== rightFlags.length) return false
  for (let index = 0; index < leftFlags.length; index++) {
    if (leftFlags[index] !== rightFlags[index]) return false
  }
  return true
}

function alignedFlagBytes(length: number): number {
  return length + (length % codeUnitBytes)
}

// Rows contain four uint32 fields (y, text length, cell count, flag count).
// Each cell has a uint32 length. Text is UTF-16LE and flags pad to an even offset.
function rowBytes(row: RendererTextFrameRow): number {
  let size =
    rowHeaderBytes + row.text.length * codeUnitBytes + alignedFlagBytes(row.continuations.length)
  for (const cell of row.cells) size += uint32Bytes + cell.length * codeUnitBytes
  return size
}

class RowWriter {
  private offset = 0
  private readonly view: DataView
  private readonly bytes: Uint8Array

  constructor(readonly buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
    this.bytes = new Uint8Array(buffer)
  }

  uint32(value: number): void {
    this.view.setUint32(this.offset, value, true)
    this.offset += uint32Bytes
  }

  private text(value: string): void {
    const view = this.view
    const start = this.offset
    for (let index = 0; index < value.length; index++) {
      view.setUint16(start + index * codeUnitBytes, value.charCodeAt(index), true)
    }
    this.offset += value.length * codeUnitBytes
  }

  row(row: RendererTextFrameRow): void {
    const cells = row.cells
    const flags = row.continuations
    this.uint32(row.y)
    this.uint32(row.text.length)
    this.uint32(cells.length)
    this.uint32(flags.length)
    this.text(row.text)
    for (const cell of cells) {
      this.uint32(cell.length)
      this.text(cell)
    }
    for (let index = 0; index < flags.length; index++) {
      this.bytes[this.offset + index] = Number(flags[index])
    }
    this.offset += alignedFlagBytes(flags.length)
  }
}

class RowReader {
  private offset = 0
  private readonly view: DataView
  private readonly bytes: Uint8Array
  private readonly words: Uint16Array | undefined

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
    this.bytes = new Uint8Array(buffer)
    if (littleEndian) this.words = new Uint16Array(buffer)
  }

  get remaining(): number {
    return this.view.byteLength - this.offset
  }

  private advance(length: number): number {
    if (length > this.remaining) throw new Error('Truncated row delta')
    const start = this.offset
    this.offset += length
    return start
  }

  uint32(): number {
    return this.view.getUint32(this.advance(uint32Bytes), true)
  }

  private codeUnits(start: number, length: number): Uint16Array {
    const first = start / codeUnitBytes
    return (
      this.words?.subarray(first, first + length) ??
      Uint16Array.from({ length }, (_, index) =>
        this.view.getUint16(start + index * codeUnitBytes, true),
      )
    )
  }

  private text(length: number): string {
    const start = this.advance(length * codeUnitBytes)
    if (length === 0) return ''
    if (length === 1) return String.fromCharCode(this.view.getUint16(start, true))
    // TextDecoder replaces isolated surrogates. Rebuild the original code units in bounded chunks.
    let value = ''
    for (let index = 0; index < length; index += codeUnitChunk) {
      const chunkLength = Math.min(codeUnitChunk, length - index)
      value += String.fromCharCode(...this.codeUnits(start + index * codeUnitBytes, chunkLength))
    }
    return value
  }

  row(): RendererTextFrameRow {
    const y = this.uint32()
    const textLength = this.uint32()
    const cellCount = this.uint32()
    const flagCount = this.uint32()
    const text = this.text(textLength)
    if (cellCount * uint32Bytes + alignedFlagBytes(flagCount) > this.remaining)
      throw new Error('Invalid row lengths')
    const cells = Array.from({ length: cellCount }, () => this.text(this.uint32()))
    const flags = this.advance(alignedFlagBytes(flagCount))
    const continuations = Array.from({ length: flagCount }, (_, index) => {
      const flag = this.bytes[flags + index]
      if (flag !== 0 && flag !== 1) throw new Error('Invalid continuation flag')
      return flag === 1
    })
    return Object.freeze({
      y,
      text,
      cells: Object.freeze(cells),
      continuations: Object.freeze(continuations),
    })
  }
}

export class RowDeltaEncoder {
  private rows = new Map<number, RendererTextFrameRow>()

  encode(frame: WorkerSubmission): WorkerFrameDelta {
    const { rows, cursor, paintedCursor, renderHeld } = frame.snapshot
    const { rows: summaryRows, rowPatches, ...summary } = frame.summary
    if (summaryRows.length !== rows.length) throw new Error('Summary and renderer rows diverged')
    const next = new Map<number, RendererTextFrameRow>()
    const changed: RendererTextFrameRow[] = []
    const order: number[] = []
    let size = uint32Bytes
    for (const [index, row] of rows.entries()) {
      const summaryRow = summaryRows[index]
      if (summaryRow?.y !== row.y || summaryRow.text !== row.text)
        throw new Error('Summary and renderer rows diverged')
      next.set(row.y, row)
      order.push(row.y)
      if (equalRow(this.rows.get(row.y), row)) continue
      changed.push(row)
      size += rowBytes(row)
    }
    const writer = new RowWriter(new ArrayBuffer(size))
    writer.uint32(changed.length)
    for (const row of changed) writer.row(row)
    this.rows = next
    return {
      ...frame,
      snapshot: { cursor, paintedCursor, renderHeld },
      summary,
      order,
      patches: rowPatches.map((row) => row.y),
      buffer: writer.buffer,
    }
  }
}

interface DecodedRow {
  readonly renderer: RendererTextFrameRow
  readonly summary: TerminalSubmittedRow
}

export class RowDeltaDecoder {
  private rows = new Map<number, DecodedRow>()

  reset(): void {
    this.rows.clear()
  }

  decode(frame: WorkerFrameDelta): WorkerSubmission {
    const { order, patches, buffer, snapshot, summary, ...header } = frame
    if (
      !snapshot?.cursor ||
      !summary ||
      !Array.isArray(order) ||
      !Array.isArray(patches) ||
      !(buffer instanceof ArrayBuffer)
    )
      throw new Error('Invalid row delta envelope')
    const reader = new RowReader(buffer)
    const count = reader.uint32()
    if (count > order.length || count * rowHeaderBytes > reader.remaining)
      throw new Error('Invalid changed row count')

    const changed = new Map<number, DecodedRow>()
    for (let index = 0; index < count; index++) {
      const renderer = reader.row()
      const { y, text } = renderer
      if (changed.has(y)) throw new Error(`Duplicate changed row ${y}`)
      const previous = this.rows.get(y)?.summary
      changed.set(y, {
        renderer,
        summary: previous?.text === text ? previous : Object.freeze({ y, text }),
      })
    }
    if (reader.remaining !== 0) throw new Error('Trailing bytes in row delta')

    const next = new Map<number, DecodedRow>()
    const rendererRows: RendererTextFrameRow[] = []
    const summaryRows: TerminalSubmittedRow[] = []
    for (const y of order) {
      const row = changed.get(y) ?? this.rows.get(y)
      if (!row || next.has(y)) throw new Error(`Invalid row order at ${y}`)
      changed.delete(y)
      next.set(y, row)
      rendererRows.push(row.renderer)
      summaryRows.push(row.summary)
    }
    if (changed.size !== 0) throw new Error('Changed row missing from row order')
    const rowPatches: TerminalSubmittedRow[] = []
    for (let index = 0; index < patches.length; index += 1) {
      const y = patches[index]
      const row = y === undefined ? undefined : next.get(y)
      if (!row) throw new Error(`Invalid row patch at ${y}`)
      rowPatches.push(row.summary)
    }

    const decoded = {
      ...header,
      snapshot: freezeWorkerValue({ ...snapshot, rows: Object.freeze(rendererRows) }),
      summary: freezeWorkerValue({
        ...summary,
        rows: Object.freeze(summaryRows),
        rowPatches: Object.freeze(rowPatches),
      }),
    }
    this.rows = next
    return decoded
  }
}
