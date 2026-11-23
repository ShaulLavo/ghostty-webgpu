import { codepointText } from './packed-cells.js'
import { SnapshotReader, type ExtractSnapshot } from './snapshot-reader.js'
import type { GhosttyRuntime } from './runtime.js'
import type { ReadTextRowsOptions, RenderTextRow, TerminalSize } from './types.js'

const rowWords = 3
const cellWords = 3
const continuationFlag = 0x80000000
const emptyGraphemes = new Uint32Array(0)

function cellText(words: Uint32Array, offset: number, graphemes: Uint32Array): string {
  const length = words[offset + 2]!
  if (length === 0) return codepointText(words[offset]! & ~continuationFlag)
  const start = words[offset + 1]!
  let text = ''
  for (let index = start; index < start + length; index += 1)
    text += String.fromCodePoint(graphemes[index]!)
  return text
}

function copiedAsciiCells(text: string, start: number, blanks: Uint32Array): readonly string[] {
  return Object.freeze(
    Array.from({ length: text.length }, (_, column) => {
      const index = start + column
      return (blanks[index >>> 5]! & (1 << (index & 31))) !== 0 ? '' : text[column]!
    }),
  )
}

function copiedAsciiRow(
  y: number,
  text: string,
  start: number,
  blanks: Uint32Array,
): RenderTextRow {
  let cells: readonly string[] | undefined
  let continuations: readonly boolean[] | undefined
  return Object.freeze({
    y,
    text,
    get cells() {
      return (cells ??= copiedAsciiCells(text, start, blanks))
    },
    get continuations() {
      return (continuations ??= Object.freeze(Array.from({ length: text.length }, () => false)))
    },
  })
}

function copiedTextRow(y: number, words: Uint32Array, graphemes: Uint32Array): RenderTextRow {
  let text = ''
  for (let offset = 0; offset < words.length; offset += cellWords) {
    if ((words[offset]! & continuationFlag) !== 0) continue
    text += cellText(words, offset, graphemes) || ' '
  }
  let cells: readonly string[] | undefined
  let continuations: readonly boolean[] | undefined
  return Object.freeze({
    y,
    text,
    get cells() {
      return (cells ??= Object.freeze(
        Array.from({ length: words.length / cellWords }, (_, index) =>
          cellText(words, index * cellWords, graphemes),
        ),
      ))
    },
    get continuations() {
      return (continuations ??= Object.freeze(
        Array.from(
          { length: words.length / cellWords },
          (_, index) => (words[index * cellWords]! & continuationFlag) !== 0,
        ),
      ))
    },
  })
}

function ownedAsciiRow(
  y: number,
  words: Uint32Array,
  bytes: Uint8Array,
  decoder: TextDecoder,
): RenderTextRow {
  const length = words.length / cellWords
  const blanks = new Uint32Array(Math.ceil(length / 32))
  for (let index = 0; index < length; index += 1) {
    const codepoint = words[index * cellWords]!
    bytes[index] = codepoint || 0x20
    if (codepoint === 0) blanks[index >>> 5]! |= 1 << (index & 31)
  }
  return copiedAsciiRow(y, decoder.decode(bytes.subarray(0, length)), 0, blanks)
}

function ownedTextRow(y: number, words: Uint32Array, graphemes: Uint32Array): RenderTextRow {
  const records = words.slice()
  // Native snapshot graphemes are contiguous within each row.
  const base = records[1] ?? 0
  const end = (records.at(-2) ?? 0) + (records.at(-1) ?? 0)
  for (let offset = 1; offset < records.length; offset += cellWords) records[offset]! -= base
  const owned = base === end ? emptyGraphemes : graphemes.slice(base, end)
  return copiedTextRow(y, records, owned)
}

function ownedRows(
  metadata: Uint32Array,
  words: Uint32Array,
  graphemes: Uint32Array,
  ascii: { bytes: Uint8Array; decoder: TextDecoder } | undefined,
): readonly RenderTextRow[] {
  const rows: RenderTextRow[] = []
  for (let offset = 0; offset < metadata.length; offset += rowWords) {
    const y = metadata[offset]!
    const start = metadata[offset + 1]! * cellWords
    const end = start + metadata[offset + 2]! * cellWords
    const cells = words.subarray(start, end)
    rows.push(
      ascii
        ? ownedAsciiRow(y, cells, ascii.bytes, ascii.decoder)
        : ownedTextRow(y, cells, graphemes),
    )
  }
  return Object.freeze(rows)
}

/**
 * The codepoints last read for each viewport row. A row redrawn with the same characters
 * (colour-only damage) keeps its owned text object instead of being rebuilt and re-sent.
 */
class RetainedTextRows {
  private codepoints = new Uint32Array(0)
  private lengths = new Int32Array(0)
  private rows: (RenderTextRow | undefined)[] = []
  private columns = 0

  /** A different grid forgets every row. */
  resize(grid: Pick<TerminalSize, 'columns' | 'rows'>): void {
    if (grid.columns === this.columns && grid.rows === this.rows.length) return
    this.columns = grid.columns
    this.codepoints = new Uint32Array(grid.columns * grid.rows)
    this.lengths = new Int32Array(grid.rows).fill(-1)
    this.rows = []
    for (let y = 0; y < grid.rows; y += 1) this.rows.push(undefined)
  }

  forget(): void {
    this.rows.fill(undefined)
  }

  canHold(y: number, length: number): boolean {
    return y < this.rows.length && length <= this.columns
  }

  /** One pass both compares and stores; the retained row comes back only when nothing changed. */
  match(y: number, words: Uint32Array, start: number, length: number): RenderTextRow | undefined {
    const base = y * this.columns
    const codepoints = this.codepoints
    let same = this.lengths[y] === length
    for (let index = 0; index < length; index += 1) {
      const codepoint = words[(start + index) * cellWords]!
      if (codepoints[base + index] === codepoint) continue
      codepoints[base + index] = codepoint
      same = false
    }
    this.lengths[y] = length
    if (!same) this.rows[y] = undefined
    return this.rows[y]
  }

  retain(row: RenderTextRow): void {
    this.rows[row.y] = row
  }

  /** Appends one stored ASCII row to a packet and returns the next packet index. */
  appendAscii(y: number, length: number, bytes: Uint8Array, blanks: Uint32Array, index: number) {
    const base = y * this.columns
    for (let column = 0; column < length; column += 1) {
      const codepoint = this.codepoints[base + column]!
      bytes[index] = codepoint || 0x20
      if (codepoint === 0) blanks[index >>> 5]! |= 1 << (index & 31)
      index += 1
    }
    return index
  }
}

export class TextRowReader {
  private readonly snapshots: SnapshotReader
  private readonly decoder = new TextDecoder()
  private asciiBytes: Uint8Array = new Uint8Array(0)
  private readonly retained = new RetainedTextRows()

  constructor(
    runtime: GhosttyRuntime,
    extract?: ExtractSnapshot,
    private readonly ownership: 'packet' | 'row' = 'packet',
  ) {
    this.snapshots = new SnapshotReader(runtime, {
      rowWords,
      cellWords,
      operation: 'bridge_read_text_rows',
      extract: extract ?? ((...args) => runtime.bridge.readTextRows(...args)),
    })
  }

  read(
    state: number,
    iterator: number,
    cells: number,
    grid: Pick<TerminalSize, 'columns' | 'rows'>,
    options: ReadTextRowsOptions,
  ): readonly RenderTextRow[] {
    if (grid.rows === 0) return Object.freeze([])
    const snapshot = this.snapshots.read(state, iterator, cells, grid, options)
    const ascii = snapshot.graphemes.length === 0 && (this.snapshots.codepointMask & ~0x7f) === 0
    if (ascii) {
      const length = snapshot.cells.length / cellWords
      if (this.asciiBytes.length < length) this.asciiBytes = new Uint8Array(length)
    }
    if (this.ownership === 'row')
      return ownedRows(
        snapshot.rows,
        snapshot.cells,
        snapshot.graphemes,
        ascii ? { bytes: this.asciiBytes, decoder: this.decoder } : undefined,
      )
    this.retained.resize(grid)
    // Without graphemes the first word of every cell fully determines the row's text.
    if (snapshot.graphemes.length === 0 && this.retainable(snapshot.rows))
      return this.packetRows(snapshot.rows, ascii ? snapshot.cells : snapshot.cells.slice(), ascii)
    this.retained.forget()
    const records = snapshot.cells.slice()
    const graphemes = snapshot.graphemes.slice()
    const rows: RenderTextRow[] = []
    for (let offset = 0; offset < snapshot.rows.length; offset += rowWords) {
      const y = snapshot.rows[offset]!
      const start = snapshot.rows[offset + 1]! * cellWords
      const end = start + snapshot.rows[offset + 2]! * cellWords
      rows.push(copiedTextRow(y, records.subarray(start, end), graphemes))
    }
    return Object.freeze(rows)
  }

  private retainable(metadata: Uint32Array): boolean {
    for (let offset = 0; offset < metadata.length; offset += rowWords) {
      if (!this.retained.canHold(metadata[offset]!, metadata[offset + 2]!)) return false
    }
    return true
  }

  /** `words` is borrowed for ASCII packets and an owned copy otherwise. */
  private packetRows(
    metadata: Uint32Array,
    words: Uint32Array,
    ascii: boolean,
  ): readonly RenderTextRow[] {
    const rows: (RenderTextRow | undefined)[] = []
    let changed = 0
    for (let offset = 0; offset < metadata.length; offset += rowWords) {
      const row = this.retained.match(
        metadata[offset]!,
        words,
        metadata[offset + 1]!,
        metadata[offset + 2]!,
      )
      rows.push(row)
      if (!row) changed += 1
    }
    if (changed > 0 && ascii) this.buildAsciiRows(metadata, rows, words.length / cellWords)
    if (changed > 0 && !ascii) this.buildPlainRows(metadata, words, rows)
    return Object.freeze(rows as RenderTextRow[])
  }

  // Changed ASCII rows share one decoded packet and one blank bitmap, built from the store.
  // The owned string and private bitmap outlive native records and scratch reuse.
  private buildAsciiRows(
    metadata: Uint32Array,
    rows: (RenderTextRow | undefined)[],
    cellCount: number,
  ): void {
    const bytes = this.asciiBytes
    const blanks = new Uint32Array(Math.ceil(cellCount / 32))
    const starts: number[] = []
    let end = 0
    for (let index = 0; index < rows.length; index += 1) {
      starts.push(end)
      if (rows[index]) continue
      const offset = index * rowWords
      end = this.retained.appendAscii(metadata[offset]!, metadata[offset + 2]!, bytes, blanks, end)
    }
    const packet = this.decoder.decode(bytes.subarray(0, end))
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index]) continue
      const offset = index * rowWords
      const start = starts[index]!
      const text = packet.slice(start, start + metadata[offset + 2]!)
      const row = copiedAsciiRow(metadata[offset]!, text, start, blanks)
      rows[index] = row
      this.retained.retain(row)
    }
  }

  private buildPlainRows(
    metadata: Uint32Array,
    records: Uint32Array,
    rows: (RenderTextRow | undefined)[],
  ): void {
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index]) continue
      const offset = index * rowWords
      const start = metadata[offset + 1]! * cellWords
      const end = start + metadata[offset + 2]! * cellWords
      const row = copiedTextRow(metadata[offset]!, records.subarray(start, end), emptyGraphemes)
      rows[index] = row
      this.retained.retain(row)
    }
  }

  dispose(): void {
    this.snapshots.dispose()
  }
}
