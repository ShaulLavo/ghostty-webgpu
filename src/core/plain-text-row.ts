import type { RenderTextRow } from './types.js'

/**
 * A plain row has exactly one UTF-16 code unit of text per cell and no continuation cells. A
 * blank cell shows as a space in the text and as '' in its cell, so the text and one bit per cell
 * describe the whole row. Transports send that instead of a string per cell.
 */
export interface PlainRowSource {
  blank(column: number): boolean
}

const sources = new WeakMap<object, PlainRowSource>()

function plainCells(text: string, source: PlainRowSource): readonly string[] {
  return Object.freeze(
    Array.from({ length: text.length }, (_, column) => (source.blank(column) ? '' : text[column]!)),
  )
}

/** An owned row whose cell and continuation arrays are built only when a consumer reads them. */
export function plainTextRow(
  y: number,
  text: string,
  start: number,
  blanks: Uint32Array,
): RenderTextRow {
  const source: PlainRowSource = {
    blank: (column) => {
      const index = start + column
      return (blanks[index >>> 5]! & (1 << (index & 31))) !== 0
    },
  }
  let cells: readonly string[] | undefined
  let continuations: readonly boolean[] | undefined
  const row = Object.freeze({
    y,
    text,
    get cells() {
      return (cells ??= plainCells(text, source))
    },
    get continuations() {
      return (continuations ??= Object.freeze(Array.from({ length: text.length }, () => false)))
    },
  })
  sources.set(row, source)
  return row
}

/** Marks a row built another way as plain, so transports can still send it compactly. */
export function markPlainTextRow(row: RenderTextRow, source: PlainRowSource): void {
  sources.set(row, source)
}

export function plainRowSource(row: object): PlainRowSource | undefined {
  return sources.get(row)
}
