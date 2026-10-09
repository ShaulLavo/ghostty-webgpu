import { SnapshotReader, type ExtractSnapshot } from './snapshot-reader.js'
import type { GhosttyRuntime } from './runtime.js'
import type { ReadTextRowsOptions, RenderTextRow, TerminalSize } from './types.js'

const rowWords = 3
const cellWords = 3
const continuationFlag = 0x80000000

function cellText(words: Uint32Array, offset: number, graphemes: Uint32Array): string {
  const length = words[offset + 2]!
  if (length === 0) {
    const codepoint = words[offset]! & ~continuationFlag
    return codepoint === 0 ? '' : String.fromCodePoint(codepoint)
  }
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

function copiedAsciiRows(
  metadata: Uint32Array,
  words: Uint32Array,
  bytes: Uint8Array,
  decoder: TextDecoder,
): readonly RenderTextRow[] {
  const length = words.length / cellWords
  const blanks = new Uint32Array(Math.ceil(length / 32))
  let index = 0
  for (let offset = 0; offset < words.length; offset += cellWords) {
    const codepoint = words[offset]!
    bytes[index] = codepoint || 0x20
    if (codepoint === 0) blanks[index >>> 5]! |= 1 << (index & 31)
    index += 1
  }
  // The owned string and private bitmap outlive native records and scratch reuse.
  const packet = decoder.decode(bytes.subarray(0, length))
  const rows: RenderTextRow[] = []
  for (let offset = 0; offset < metadata.length; offset += rowWords) {
    const y = metadata[offset]!
    const start = metadata[offset + 1]!
    const length = metadata[offset + 2]!
    rows.push(copiedAsciiRow(y, packet.slice(start, start + length), start, blanks))
  }
  return Object.freeze(rows)
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

export class TextRowReader {
  private readonly snapshots: SnapshotReader
  private readonly decoder = new TextDecoder()
  private asciiBytes: Uint8Array = new Uint8Array(0)

  constructor(runtime: GhosttyRuntime, extract?: ExtractSnapshot) {
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
    if (snapshot.graphemes.length === 0 && (this.snapshots.codepointMask & ~0x7f) === 0) {
      const length = snapshot.cells.length / cellWords
      if (this.asciiBytes.length < length) this.asciiBytes = new Uint8Array(length)
      return copiedAsciiRows(snapshot.rows, snapshot.cells, this.asciiBytes, this.decoder)
    }
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

  dispose(): void {
    this.snapshots.dispose()
  }
}
