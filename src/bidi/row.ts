import bidiFactory from 'bidi-js'
import type { RenderCell, RenderRow } from '../core/types.js'
import type { CursorState } from '../render/shared/instances/types.js'

export interface RowBidiMap {
  readonly visualToLogical: readonly number[]
  readonly logicalToVisual: readonly number[]
  readonly mirror: ReadonlyMap<number, string>
}

export class RowBidiMapper {
  private readonly bidi = bidiFactory()
  private readonly cache = new Map<string, RowBidiMap>()

  getMap(cells: readonly Pick<RenderCell, 'text' | 'continuation'>[]): RowBidiMap {
    const key = JSON.stringify(cells.map((cell) => [cell.text, cell.continuation]))
    const cached = this.cache.get(key)
    if (cached) return cached
    const map = this.compute(cells)
    if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, map)
    return map
  }

  paint(row: RenderRow): RenderRow {
    const cells = row.cells
    const map = this.getMap(cells)
    return {
      dirty: row.dirty,
      y: row.y,
      cells: map.visualToLogical.map((logical, x) => {
        const cell = cells[logical]!
        const mirror = map.mirror.get(logical)
        return {
          ...cell,
          x,
          text: mirror
            ? mirror + cell.text.slice(String.fromCodePoint(cell.text.codePointAt(0) ?? 0).length)
            : cell.text,
        }
      }),
    }
  }

  cursor(row: RenderRow, cursor: CursorState | undefined): CursorState | undefined {
    if (!cursor || cursor.y !== row.y) return cursor
    return { ...cursor, x: this.getMap(row.cells).logicalToVisual[cursor.x] ?? cursor.x }
  }

  private compute(cells: readonly Pick<RenderCell, 'text' | 'continuation'>[]): RowBidiMap {
    let text = ''
    const owners: number[] = []
    for (const [index, cell] of cells.entries()) {
      if (cell.continuation) continue
      const scalar = String.fromCodePoint(cell.text.codePointAt(0) || 32)
      text += scalar
      for (let unit = 0; unit < scalar.length; unit += 1) owners.push(index)
    }
    const levels = this.bidi.getEmbeddingLevels(text, 'ltr')
    const visualToLogical: number[] = []
    const seen = new Set<number>()
    for (const unit of this.bidi.getReorderedIndices(text, levels)) {
      const logical = owners[unit]!
      if (seen.has(logical)) continue
      seen.add(logical)
      visualToLogical.push(logical)
      if (!cells[logical + 1]?.continuation) continue
      seen.add(logical + 1)
      visualToLogical.push(logical + 1)
    }
    for (let logical = 0; logical < cells.length; logical += 1) {
      if (!seen.has(logical)) visualToLogical.push(logical)
    }
    const logicalToVisual = Array.from({ length: cells.length }, () => 0)
    for (const [visual, logical] of visualToLogical.entries()) logicalToVisual[logical] = visual
    const mirror = new Map<number, string>()
    for (const [unit, character] of this.bidi.getMirroredCharactersMap(text, levels.levels))
      mirror.set(owners[unit]!, character)
    return { visualToLogical, logicalToVisual, mirror }
  }
}

export function bidiProjection(rows: readonly RenderRow[], mapper: RowBidiMapper): Uint32Array {
  const result = new Uint32Array(rows.reduce((sum, row) => sum + row.cells.length * 3, 0))
  let offset = 0
  for (const row of rows) {
    const map = mapper.getMap(row.cells)
    for (const cell of row.cells) {
      result[offset++] = map.logicalToVisual[cell.x]!
      result[offset++] = map.mirror.get(cell.x)?.codePointAt(0) ?? 0
      result[offset++] = Number(cell.selected)
    }
  }
  return result
}

export function paintedBidiCursor(
  mapper: RowBidiMapper | undefined,
  source: { readRows(options: { rows: ReadonlySet<number> }): readonly RenderRow[] },
  cursor: CursorState | undefined,
): CursorState | undefined {
  if (!mapper || !cursor) return cursor
  const row = source.readRows({ rows: new Set([cursor.y]) }).find((row) => row.y === cursor.y)
  return row ? mapper.cursor(row, cursor) : cursor
}
