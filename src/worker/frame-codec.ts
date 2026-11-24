import type { TerminalSubmittedRow } from '../dom/submitted-frame.js'
import type { RendererTextFrameRow } from '../render/shared/types.js'
import { plainRowSource, plainTextRow, type PlainRowSource } from '../core/plain-text-row.js'
import { freezeWorkerValue } from './owned.js'
import type { WorkerFrameDelta, WorkerSubmission } from './protocol.js'

const uint32Bytes = 4
const codeUnitBytes = 2
const rowHeaderBytes = 4 * uint32Bytes
const codeUnitChunk = 4096
// A plain row stores this in its cell-count field and its blank bitmap length in the flag field.
const plainRow = 0xffffffff
const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1

function sameBlanks(left: PlainRowSource, right: PlainRowSource, length: number): boolean {
  for (let column = 0; column < length; column++) {
    if (left.blank(column) !== right.blank(column)) return false
  }
  return true
}

function equalRow(left: RendererTextFrameRow | undefined, right: RendererTextFrameRow): boolean {
  if (left === right) return true
  if (!left || left.text !== right.text) return false
  const leftPlain = plainRowSource(left)
  const rightPlain = plainRowSource(right)
  // Two plain rows with equal text differ only where a blank became a space or back.
  if (leftPlain && rightPlain) return sameBlanks(leftPlain, rightPlain, right.text.length)
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

function blankWords(length: number): number {
  return Math.ceil(length / 32)
}

// Rows contain four uint32 fields (y, text length, cell count, flag count).
// Each cell has a uint32 length. Text is UTF-16LE and flags pad to an even offset.
// A plain row replaces its cells and flags with one blank bit per code unit of its text.
function rowBytes(row: RendererTextFrameRow, plain: PlainRowSource | undefined): number {
  const header = rowHeaderBytes + row.text.length * codeUnitBytes
  if (plain) return header + blankWords(row.text.length) * uint32Bytes
  let size = header + alignedFlagBytes(row.continuations.length)
  for (const cell of row.cells) size += uint32Bytes + cell.length * codeUnitBytes
  return size
}

function blankBits(source: PlainRowSource, word: number, length: number): number {
  const first = word * 32
  const end = Math.min(length, first + 32)
  let bits = 0
  for (let column = first; column < end; column++) {
    if (source.blank(column)) bits |= 1 << (column - first)
  }
  return bits >>> 0
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

  // The text and one blank bit per cell stand in for 100 small cell strings per row.
  plain(row: RendererTextFrameRow, source: PlainRowSource): void {
    const words = blankWords(row.text.length)
    this.uint32(row.y)
    this.uint32(row.text.length)
    this.uint32(plainRow)
    this.uint32(words)
    this.text(row.text)
    for (let word = 0; word < words; word++) this.uint32(blankBits(source, word, row.text.length))
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

  // Cells stay unbuilt until a consumer (links, accessibility) reads them.
  private plain(y: number, text: string, words: number): RendererTextFrameRow {
    if (words !== blankWords(text.length)) throw new Error('Invalid plain row bitmap')
    const blanks = new Uint32Array(words)
    for (let word = 0; word < words; word++) blanks[word] = this.uint32()
    return plainTextRow(y, text, 0, blanks)
  }

  row(): RendererTextFrameRow {
    const y = this.uint32()
    const textLength = this.uint32()
    const cellCount = this.uint32()
    const flagCount = this.uint32()
    const text = this.text(textLength)
    if (cellCount === plainRow) return this.plain(y, text, flagCount)
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
  private font?: WorkerSubmission['summary']['font']
  private theme?: WorkerSubmission['summary']['theme']

  encode(frame: WorkerSubmission): WorkerFrameDelta {
    const { rows, cursor, paintedCursor, renderHeld } = frame.snapshot
    const { rows: summaryRows, rowPatches, font, theme, ...summary } = frame.summary
    if (summaryRows.length !== rows.length) throw new Error('Summary and renderer rows diverged')
    const next = new Map<number, RendererTextFrameRow>()
    const changed: { row: RendererTextFrameRow; plain: PlainRowSource | undefined }[] = []
    const order: number[] = []
    let size = uint32Bytes
    for (const [index, row] of rows.entries()) {
      const summaryRow = summaryRows[index]
      if (summaryRow?.y !== row.y || summaryRow.text !== row.text)
        throw new Error('Summary and renderer rows diverged')
      next.set(row.y, row)
      order.push(row.y)
      if (equalRow(this.rows.get(row.y), row)) continue
      const plain = plainRowSource(row)
      changed.push({ row, plain })
      size += rowBytes(row, plain)
    }
    const writer = new RowWriter(new ArrayBuffer(size))
    writer.uint32(changed.length)
    for (const { row, plain } of changed) {
      if (plain) writer.plain(row, plain)
      else writer.row(row)
    }
    this.rows = next
    // The decoder keeps the last font and theme, so only a new identity is sent.
    const appearance = {
      ...(font === this.font ? {} : { font }),
      ...(theme === this.theme ? {} : { theme }),
    }
    this.font = font
    this.theme = theme
    return {
      ...frame,
      snapshot: { cursor, paintedCursor, renderHeld },
      summary: { ...summary, ...appearance },
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
  private font?: WorkerSubmission['summary']['font']
  private theme?: WorkerSubmission['summary']['theme']

  reset(): void {
    this.rows.clear()
    this.font = undefined
    this.theme = undefined
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

    const font = summary.font ?? this.font
    const theme = summary.theme ?? this.theme
    if (!font || !theme) throw new Error('Row delta is missing its font or theme')
    const decoded = {
      ...header,
      snapshot: freezeWorkerValue({ ...snapshot, rows: Object.freeze(rendererRows) }),
      summary: freezeWorkerValue({
        ...summary,
        font,
        theme,
        rows: Object.freeze(summaryRows),
        rowPatches: Object.freeze(rowPatches),
      }),
    }
    this.rows = next
    this.font = decoded.summary.font
    this.theme = decoded.summary.theme
    return decoded
  }
}
