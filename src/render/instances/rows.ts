import type { RenderCell, RenderRow, RgbColor } from '../../core/types.js'
import {
  CELL_INSTANCE_BYTES,
  CELL_INSTANCE_FLOATS,
  CellFlag,
  CellOffset,
  GLYPH_INSTANCE_BYTES,
  GLYPH_INSTANCE_FLOATS,
  GlyphFlag,
  GlyphOffset,
} from './layout.js'
import type {
  CursorState,
  GlyphLookup,
  GlyphSource,
  InstanceByteRange,
  InstanceRowsOptions,
  RendererTheme,
  RowInstanceUpdate,
} from './types.js'

interface CellColors {
  background: RgbColor
  drawBackground: boolean
  foreground: RgbColor
}

function validateDimension(name: string, value: number): number {
  if (Number.isInteger(value) && value > 0) return value
  throw new RangeError(`${name} must be a positive integer`)
}

function normalized(color: RgbColor): readonly [number, number, number] {
  return [color.r / 255, color.g / 255, color.b / 255]
}

function colorsForCell(cell: RenderCell, theme: RendererTheme, blockCursor: boolean): CellColors {
  let foreground = cell.foreground ?? theme.foreground
  let background = cell.background ?? theme.background
  let drawBackground = cell.background !== undefined
  if (cell.style?.inverse) {
    const previousForeground = foreground
    foreground = background
    background = previousForeground
    drawBackground = true
  }
  if (cell.selected) {
    foreground = theme.selectionForeground
    background = theme.selectionBackground
    drawBackground = true
  }
  if (!blockCursor) return { background, drawBackground, foreground }
  return { background: theme.cursor, drawBackground: true, foreground: theme.background }
}

function cellFlags(cell: RenderCell, cursor: CursorState | undefined): number {
  let flags = 0
  if (cell.style?.strikethrough) flags |= CellFlag.Strikethrough
  if (cell.style?.overline) flags |= CellFlag.Overline
  if (cursor) flags |= CellFlag.Cursor
  return flags
}

function cellNeedsQuad(
  cell: RenderCell,
  colors: CellColors,
  cursor: CursorState | undefined,
): boolean {
  if (colors.drawBackground || cursor) return true
  if ((cell.style?.underline ?? 0) > 0) return true
  return cell.style?.strikethrough === true || cell.style?.overline === true
}

function cursorForCell(
  cursor: CursorState | undefined,
  cell: RenderCell,
  row: number,
): CursorState | undefined {
  if (!cursor?.visible) return undefined
  if (cursor.x !== cell.x || cursor.y !== row) return undefined
  return cursor
}

function byteRange(row: number, columns: number, instanceBytes: number): InstanceByteRange {
  return {
    byteLength: columns * instanceBytes,
    byteOffset: row * columns * instanceBytes,
  }
}

function cellSpan(cells: readonly RenderCell[], index: number): number {
  let span = 1
  while (cells[index + span]?.continuation) span += 1
  return span
}

function glyphCacheKey(cell: RenderCell, span: number): string {
  return JSON.stringify([
    span,
    cell.style?.bold ? 'bold' : 'normal',
    cell.style?.italic ?? false,
    cell.text,
  ])
}

function cursorStyleCode(style: CursorState['style'] | undefined): number {
  if (style === 'bar') return 1
  if (style === 'underline') return 2
  if (style === 'outline') return 3
  return 0
}

export class InstanceRows {
  readonly cellData: Float32Array
  readonly glyphData: Float32Array
  readonly cellHeight: number
  readonly cellWidth: number
  readonly columns: number
  readonly rows: number

  constructor(options: InstanceRowsOptions) {
    this.columns = validateDimension('columns', options.columns)
    this.rows = validateDimension('rows', options.rows)
    this.cellWidth = validateDimension('cellWidth', options.cellWidth)
    this.cellHeight = validateDimension('cellHeight', options.cellHeight)
    const cells = this.columns * this.rows
    this.cellData = new Float32Array(cells * CELL_INSTANCE_FLOATS)
    this.glyphData = new Float32Array(cells * GLYPH_INSTANCE_FLOATS)
  }

  rebuildRow(
    row: RenderRow,
    glyphs: GlyphLookup,
    source: GlyphSource,
    theme: RendererTheme,
    cursor?: CursorState,
  ): RowInstanceUpdate {
    this.validateRow(row.y)
    glyphs.beginRow(row.y)
    this.clearRow(row.y)
    const invalidatedRows = new Set<number>()
    for (let index = 0; index < row.cells.length; index += 1) {
      const cell = row.cells[index]!
      if (cell.x >= this.columns) continue
      this.writeCell(
        row.y,
        cell,
        cellSpan(row.cells, index),
        glyphs,
        source,
        theme,
        cursor,
        invalidatedRows,
      )
    }
    return {
      cell: byteRange(row.y, this.columns, CELL_INSTANCE_BYTES),
      glyph: byteRange(row.y, this.columns, GLYPH_INSTANCE_BYTES),
      invalidatedRows: [...invalidatedRows].sort((left, right) => left - right),
      row: row.y,
    }
  }

  rangesForAllRows(): readonly RowInstanceUpdate[] {
    const updates: RowInstanceUpdate[] = []
    for (let row = 0; row < this.rows; row += 1) {
      updates.push({
        cell: byteRange(row, this.columns, CELL_INSTANCE_BYTES),
        glyph: byteRange(row, this.columns, GLYPH_INSTANCE_BYTES),
        invalidatedRows: [],
        row,
      })
    }
    return updates
  }

  private clearRow(row: number): void {
    const firstCell = row * this.columns
    const cellStart = firstCell * CELL_INSTANCE_FLOATS
    const glyphStart = firstCell * GLYPH_INSTANCE_FLOATS
    this.cellData.fill(0, cellStart, cellStart + this.columns * CELL_INSTANCE_FLOATS)
    this.glyphData.fill(0, glyphStart, glyphStart + this.columns * GLYPH_INSTANCE_FLOATS)
  }

  private validateRow(row: number): void {
    if (Number.isInteger(row) && row >= 0 && row < this.rows) return
    throw new RangeError(`row ${row} is outside the instance grid`)
  }

  private writeCell(
    row: number,
    cell: RenderCell,
    span: number,
    glyphs: GlyphLookup,
    source: GlyphSource,
    theme: RendererTheme,
    cursorState: CursorState | undefined,
    invalidatedRows: Set<number>,
  ): void {
    const cursor = cursorForCell(cursorState, cell, row)
    const colors = colorsForCell(cell, theme, cursor?.style === 'block')
    this.writeCellInstance(row, cell, colors, cursor, theme.minimumContrast)
    if (cell.continuation) return
    this.writeGlyph(row, cell, span, colors, glyphs, source, theme.minimumContrast, invalidatedRows)
  }

  private writeCellInstance(
    row: number,
    cell: RenderCell,
    colors: CellColors,
    cursor: CursorState | undefined,
    minimumContrast: number,
  ): void {
    const offset = (row * this.columns + cell.x) * CELL_INSTANCE_FLOATS
    if (cellNeedsQuad(cell, colors, cursor)) {
      this.writeRect(this.cellData, offset + CellOffset.Rect, row, cell.x)
    }
    this.writeColor(this.cellData, offset + CellOffset.Foreground, colors.foreground, 1)
    this.writeColor(
      this.cellData,
      offset + CellOffset.Background,
      colors.background,
      colors.drawBackground ? 1 : 0,
    )
    this.cellData[offset + CellOffset.Meta] = cellFlags(cell, cursor)
    this.cellData[offset + CellOffset.Meta + 1] = cell.style?.underline ?? 0
    this.cellData[offset + CellOffset.Meta + 2] = cursorStyleCode(cursor?.style)
    this.cellData[offset + CellOffset.Meta + 3] = minimumContrast
  }

  private writeGlyph(
    row: number,
    cell: RenderCell,
    span: number,
    colors: CellColors,
    glyphs: GlyphLookup,
    source: GlyphSource,
    minimumContrast: number,
    invalidatedRows: Set<number>,
  ): void {
    if (!cell.text || cell.style?.invisible) return
    const bitmap = source.rasterize({
      cellSpan: span,
      italic: cell.style?.italic ?? false,
      text: cell.text,
      weight: cell.style?.bold ? 'bold' : 'normal',
    })
    if (!bitmap) return
    const result = glyphs.resolve(glyphCacheKey(cell, span), bitmap, row)
    for (const invalidated of result.invalidatedRows) invalidatedRows.add(invalidated)
    const glyph = result.glyph
    const offset = (row * this.columns + cell.x) * GLYPH_INSTANCE_FLOATS
    this.writeGlyphRect(offset, row, cell.x, glyph)
    const alpha = cell.style?.faint ? 0.5 : 1
    this.writeColor(this.glyphData, offset + GlyphOffset.Color, colors.foreground, alpha)
    this.writeColor(this.glyphData, offset + GlyphOffset.Background, colors.background, 1)
    this.glyphData[offset + GlyphOffset.Meta] = GlyphFlag.Glyph
    this.glyphData[offset + GlyphOffset.Meta + 2] = minimumContrast
    this.glyphData[offset + GlyphOffset.Uv] = glyph.x / glyph.atlasWidth
    this.glyphData[offset + GlyphOffset.Uv + 1] = glyph.y / glyph.atlasHeight
    this.glyphData[offset + GlyphOffset.Uv + 2] = (glyph.x + glyph.width) / glyph.atlasWidth
    this.glyphData[offset + GlyphOffset.Uv + 3] = (glyph.y + glyph.height) / glyph.atlasHeight
    this.glyphData[offset + GlyphOffset.Atlas] = glyph.layer
    this.glyphData[offset + GlyphOffset.Atlas + 1] = glyph.generation
    this.glyphData[offset + GlyphOffset.Atlas + 2] = glyph.kind === 'color' ? 1 : 0
  }

  private writeGlyphRect(
    offset: number,
    row: number,
    column: number,
    glyph: { height: number; offsetX: number; offsetY: number; width: number },
  ): void {
    this.glyphData[offset + GlyphOffset.Rect] = column * this.cellWidth + glyph.offsetX
    this.glyphData[offset + GlyphOffset.Rect + 1] = row * this.cellHeight + glyph.offsetY
    this.glyphData[offset + GlyphOffset.Rect + 2] = glyph.width
    this.glyphData[offset + GlyphOffset.Rect + 3] = glyph.height
  }

  private writeRect(
    data: Float32Array,
    offset: number,
    row: number,
    column: number,
    span = 1,
  ): void {
    data[offset] = column * this.cellWidth
    data[offset + 1] = row * this.cellHeight
    data[offset + 2] = this.cellWidth * span
    data[offset + 3] = this.cellHeight
  }

  private writeColor(data: Float32Array, offset: number, color: RgbColor, alpha: number): void {
    const [red, green, blue] = normalized(color)
    data[offset] = red
    data[offset + 1] = green
    data[offset + 2] = blue
    data[offset + 3] = alpha
  }
}
