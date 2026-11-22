import bidiFactory from 'bidi-js'
import type { RenderCell, RenderRow } from '../core/types.js'
import type { CursorState } from '../render/shared/instances/types.js'

export interface RowBidiMap {
  readonly identity: boolean
  readonly visualToLogical: readonly number[]
  readonly logicalToVisual: readonly number[]
  readonly mirror: ReadonlyMap<number, string>
}

type BidiCell = Pick<RenderCell, 'text' | 'continuation'>

function isIdentityRow(cells: readonly BidiCell[]): boolean {
  // Code points before Hebrew have no class that can create an odd level in an LTR row.
  let previousContinuation = true
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!
    if (cell.text.charCodeAt(0) >= 0x0590) return false
    if (cell.continuation && previousContinuation) return false
    previousContinuation = cell.continuation
  }
  return true
}

function bidiCacheKey(cells: readonly BidiCell[]): string {
  // Surrogate prefixes reserve tokens for continuations and for scalars with surrogate units.
  let key = ''
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!
    if (cell.continuation) {
      key += '\udc00'
      continue
    }
    const first = cell.text[0]
    if (first === undefined || first === '\u0000') {
      key += ' '
      continue
    }
    if (first < '\ud800' || first > '\udfff') {
      key += first
      continue
    }
    const scalar = cell.text.codePointAt(0)!
    key += String.fromCharCode(0xd800, scalar >>> 16, scalar & 0xffff)
  }
  return key
}

export class RowBidiMapper {
  private readonly bidi = bidiFactory()
  private readonly cache = new Map<string, RowBidiMap>()
  private readonly identityMaps = new Map<number, RowBidiMap>()

  getMap(cells: readonly BidiCell[]): RowBidiMap {
    if (isIdentityRow(cells)) return this.identityMap(cells.length)
    const key = bidiCacheKey(cells)
    const cached = this.cache.get(key)
    if (cached) return cached
    const map = this.compute(cells)
    if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, map)
    return map
  }

  private identityMap(length: number): RowBidiMap {
    const cached = this.identityMaps.get(length)
    if (cached) return cached
    const columns = Array.from({ length }, (_, index) => index)
    const map = {
      identity: true,
      visualToLogical: columns,
      logicalToVisual: columns,
      mirror: new Map<number, string>(),
    }
    this.identityMaps.set(length, map)
    return map
  }

  paint(row: RenderRow): RenderRow {
    const cells = row.cells
    const map = this.getMap(cells)
    return {
      dirty: row.dirty,
      y: row.y,
      logicalColumns: map.visualToLogical.map((logical) =>
        map.mirror.has(logical) ? -1 : logical,
      ),
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

  projection(rows: readonly RenderRow[]): Uint32Array {
    return bidiProjection(rows, this)
  }

  writeProjection(rows: readonly RenderRow[], target: Uint32Array, columns: number): void {
    writeBidiProjection(rows, this, target, columns)
  }

  paintedCursor(
    source: { readRows(options: { rows: ReadonlySet<number> }): readonly RenderRow[] },
    cursor: CursorState | undefined,
  ): CursorState | undefined {
    return paintedBidiCursor(this, source, cursor)
  }

  private compute(cells: readonly BidiCell[]): RowBidiMap {
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
    return { identity: false, visualToLogical, logicalToVisual, mirror }
  }
}

export function bidiProjection(rows: readonly RenderRow[], mapper: RowBidiMapper): Uint32Array {
  const result = new Uint32Array(rows.reduce((sum, row) => sum + row.cells.length * 3, 0))
  let offset = 0
  for (const row of rows) {
    const map = mapper.getMap(row.cells)
    for (const cell of row.cells) {
      writeBidiCell(result, offset, map, cell)
      offset += 3
    }
  }
  return result
}

export function writeBidiProjection(
  rows: readonly RenderRow[],
  mapper: RowBidiMapper,
  target: Uint32Array,
  columns: number,
): void {
  for (const row of rows) {
    const map = mapper.getMap(row.cells)
    for (const cell of row.cells) {
      const offset = (row.y * columns + cell.x) * 3
      writeBidiCell(target, offset, map, cell)
    }
  }
}

function writeBidiCell(
  target: Uint32Array,
  offset: number,
  map: RowBidiMap,
  cell: RenderRow['cells'][number],
): void {
  if (map.identity) {
    target[offset] = cell.x
    target[offset + 1] = 0
    target[offset + 2] = Number(cell.selected)
    return
  }
  target[offset] = map.logicalToVisual[cell.x]!
  target[offset + 1] = map.mirror.get(cell.x)?.codePointAt(0) ?? 0
  target[offset + 2] = Number(cell.selected)
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
