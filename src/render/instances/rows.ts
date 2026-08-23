import type { RenderCell, RenderRow, RgbColor } from '../../core/types.js'
import {
  BACKGROUND_INSTANCE_BYTES,
  BACKGROUND_INSTANCE_FLOATS,
  BackgroundOffset,
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

function colorsForCell(cell: RenderCell, theme: RendererTheme, cursor: boolean): CellColors {
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
  if (!cursor) return { background, drawBackground, foreground }
  return { background: theme.cursor, drawBackground: true, foreground: theme.background }
}

function glyphFlags(cell: RenderCell, cursor: CursorState | undefined): number {
  let flags = 0
  const underline = cell.style?.underline ?? 0
  if (underline > 0) flags |= GlyphFlag.Underline
  if (underline === 3) flags |= GlyphFlag.Undercurl
  if (cell.style?.strikethrough) flags |= GlyphFlag.Strikethrough
  if (cell.style?.overline) flags |= GlyphFlag.Overline
  if (cell.style?.inverse) flags |= GlyphFlag.Inverse
  if (cell.selected) flags |= GlyphFlag.Selected
  if (cell.style?.invisible) flags |= GlyphFlag.Invisible
  if (!cursor) return flags
  flags |= GlyphFlag.Cursor
  if (cursor.style === 'outline') flags |= GlyphFlag.OutlineCursor
  return flags
}

function cursorForCell(cursor: CursorState | undefined, cell: RenderCell, row: number) {
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

export class InstanceRows {
  readonly backgroundData: Float32Array
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
    this.backgroundData = new Float32Array(cells * BACKGROUND_INSTANCE_FLOATS)
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
    for (const cell of row.cells) {
      if (cell.x >= this.columns) continue
      this.writeCell(row.y, cell, glyphs, source, theme, cursor, invalidatedRows)
    }
    return {
      background: byteRange(row.y, this.columns, BACKGROUND_INSTANCE_BYTES),
      glyph: byteRange(row.y, this.columns, GLYPH_INSTANCE_BYTES),
      invalidatedRows: [...invalidatedRows].sort((left, right) => left - right),
      row: row.y,
    }
  }

  rangesForAllRows(): readonly RowInstanceUpdate[] {
    const updates: RowInstanceUpdate[] = []
    for (let row = 0; row < this.rows; row += 1) {
      updates.push({
        background: byteRange(row, this.columns, BACKGROUND_INSTANCE_BYTES),
        glyph: byteRange(row, this.columns, GLYPH_INSTANCE_BYTES),
        invalidatedRows: [],
        row,
      })
    }
    return updates
  }

  private clearRow(row: number): void {
    const firstCell = row * this.columns
    const backgroundStart = firstCell * BACKGROUND_INSTANCE_FLOATS
    const glyphStart = firstCell * GLYPH_INSTANCE_FLOATS
    this.backgroundData.fill(0, backgroundStart, backgroundStart + this.columns * 8)
    this.glyphData.fill(0, glyphStart, glyphStart + this.columns * 24)
  }

  private validateRow(row: number): void {
    if (Number.isInteger(row) && row >= 0 && row < this.rows) return
    throw new RangeError(`row ${row} is outside the instance grid`)
  }

  private writeCell(
    row: number,
    cell: RenderCell,
    glyphs: GlyphLookup,
    source: GlyphSource,
    theme: RendererTheme,
    cursorState: CursorState | undefined,
    invalidatedRows: Set<number>,
  ): void {
    const cursor = cursorForCell(cursorState, cell, row)
    const blockCursor = cursor?.style === 'block'
    const colors = colorsForCell(cell, theme, blockCursor)
    this.writeBackground(row, cell.x, colors)
    this.writeGlyph(row, cell, colors, cursor, glyphs, source, theme, invalidatedRows)
  }

  private writeBackground(row: number, column: number, colors: CellColors): void {
    const offset = (row * this.columns + column) * BACKGROUND_INSTANCE_FLOATS
    this.writeRect(this.backgroundData, offset + BackgroundOffset.Rect, row, column)
    const [red, green, blue] = normalized(colors.background)
    this.backgroundData[offset + BackgroundOffset.Color] = red
    this.backgroundData[offset + BackgroundOffset.Color + 1] = green
    this.backgroundData[offset + BackgroundOffset.Color + 2] = blue
    this.backgroundData[offset + BackgroundOffset.Color + 3] = colors.drawBackground ? 1 : 0
  }

  private writeGlyph(
    row: number,
    cell: RenderCell,
    colors: CellColors,
    cursor: CursorState | undefined,
    glyphs: GlyphLookup,
    source: GlyphSource,
    theme: RendererTheme,
    invalidatedRows: Set<number>,
  ): void {
    const offset = (row * this.columns + cell.x) * GLYPH_INSTANCE_FLOATS
    this.writeRect(this.glyphData, offset + GlyphOffset.Rect, row, cell.x)
    this.writeColor(this.glyphData, offset + GlyphOffset.Color, colors.foreground, 1)
    this.writeColor(this.glyphData, offset + GlyphOffset.Background, colors.background, 1)
    let flags = glyphFlags(cell, cursor)
    if (cell.text && !cell.continuation)
      flags |= this.writeGlyphAtlas(offset, cell.text, row, glyphs, source, invalidatedRows)
    this.glyphData[offset + GlyphOffset.Meta] = flags
    this.glyphData[offset + GlyphOffset.Meta + 1] = cursorStyleCode(cursor?.style)
    this.glyphData[offset + GlyphOffset.Meta + 2] = theme.minimumContrast
  }

  private writeGlyphAtlas(
    offset: number,
    text: string,
    row: number,
    glyphs: GlyphLookup,
    source: GlyphSource,
    invalidatedRows: Set<number>,
  ): number {
    const bitmap = source.rasterize(text)
    const result = glyphs.resolve(text, bitmap, row)
    for (const invalidated of result.invalidatedRows) invalidatedRows.add(invalidated)
    const glyph = result.glyph
    this.glyphData[offset + GlyphOffset.Uv] = glyph.x / glyph.atlasWidth
    this.glyphData[offset + GlyphOffset.Uv + 1] = glyph.y / glyph.atlasHeight
    this.glyphData[offset + GlyphOffset.Uv + 2] = (glyph.x + glyph.width) / glyph.atlasWidth
    this.glyphData[offset + GlyphOffset.Uv + 3] = (glyph.y + glyph.height) / glyph.atlasHeight
    this.glyphData[offset + GlyphOffset.Atlas] = glyph.pageId
    this.glyphData[offset + GlyphOffset.Atlas + 1] = glyph.generation
    this.glyphData[offset + GlyphOffset.Atlas + 2] = glyph.kind === 'color' ? 1 : 0
    return GlyphFlag.Glyph
  }

  private writeRect(data: Float32Array, offset: number, row: number, column: number): void {
    data[offset] = column * this.cellWidth
    data[offset + 1] = row * this.cellHeight
    data[offset + 2] = this.cellWidth
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

function cursorStyleCode(style: CursorState['style'] | undefined): number {
  if (style === 'bar') return 1
  if (style === 'underline') return 2
  if (style === 'outline') return 3
  return 0
}
