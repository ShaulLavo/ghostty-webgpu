import type { RenderCell, RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import type { CanonicalRendererTheme, CursorState } from '../instances/types.js'
import { CanvasColorCache, resolveCanvasCellColors, type CanvasCellColors } from './colors.js'

export type Canvas2dContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function fontString(font: TerminalFittedFont, bold: boolean, italic: boolean): string {
  const prefix = italic ? 'italic ' : ''
  const weight = bold ? font.settings.boldWeight : font.settings.weight
  return `${prefix}${weight} ${font.settings.size * font.pixelRatio}px ${font.settings.family}`
}

function cellSpan(cells: readonly RenderCell[], index: number): number {
  let span = 1
  while (cells[index + span]?.continuation) span += 1
  return span
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

export class CanvasRowPainter {
  private backgroundColor?: string
  private backgroundStart = 0
  private backgroundEnd = 0
  private readonly cellColors: CanvasCellColors[] = []
  private colors: CanvasColorCache
  private currentAlpha = 1
  private currentFill?: string
  private currentFont?: string
  private fonts: readonly string[] = []

  constructor(
    private readonly context: Canvas2dContext,
    private font: TerminalFittedFont,
    private theme: CanonicalRendererTheme,
  ) {
    this.colors = new CanvasColorCache(theme.minimumContrast)
  }

  resetContext(font: TerminalFittedFont): void {
    this.font = font
    this.fonts = [
      fontString(font, false, false),
      fontString(font, true, false),
      fontString(font, false, true),
      fontString(font, true, true),
    ]
    this.context.font = this.fonts[0]!
    this.context.textAlign = 'center'
    this.context.textBaseline = 'alphabetic'
  }

  setTheme(theme: CanonicalRendererTheme): void {
    this.theme = theme
    this.colors = new CanvasColorCache(theme.minimumContrast)
  }

  paint(row: RenderRow, cursor: CursorState | undefined, width: number): void {
    const y = row.y * this.font.deviceCellHeight
    this.currentFill = undefined
    this.currentFont = this.fonts[0]
    this.currentAlpha = 1
    this.cellColors.length = row.cells.length
    this.context.save()
    this.context.beginPath()
    this.context.rect(0, y, width, this.font.deviceCellHeight)
    this.context.clip()
    this.context.clearRect(0, y, width, this.font.deviceCellHeight)
    this.paintBackgrounds(row, cursor, y)
    for (let index = 0; index < row.cells.length; index += 1) this.paintGlyph(row, index)
    this.context.restore()
  }

  private paintBackgrounds(row: RenderRow, cursor: CursorState | undefined, y: number): void {
    for (let index = 0; index < row.cells.length; index += 1) {
      const cell = row.cells[index]!
      const cellCursor = cursorForCell(cursor, cell, row.y)
      const colors = resolveCanvasCellColors(cell, this.theme, cellCursor?.style === 'block')
      this.cellColors[index] = colors
      const x = cell.x * this.font.deviceCellWidth
      this.appendBackground(colors, x, y)
      this.paintDecorations(cell, colors, x, y)
      this.paintCursor(cellCursor, colors, x, y)
    }
    this.flushBackground(y)
  }

  private appendBackground(colors: CanvasCellColors, x: number, y: number): void {
    if (!colors.drawBackground) {
      this.flushBackground(y)
      return
    }
    const color = this.colors.css(colors.background)
    if (this.backgroundColor !== color || this.backgroundEnd !== x) {
      this.flushBackground(y)
      this.backgroundColor = color
      this.backgroundStart = x
    }
    this.backgroundEnd = x + this.font.deviceCellWidth
  }

  private flushBackground(y: number): void {
    if (this.backgroundColor === undefined) return
    this.setFill(this.backgroundColor)
    this.context.fillRect(
      this.backgroundStart,
      y,
      this.backgroundEnd - this.backgroundStart,
      this.font.deviceCellHeight,
    )
    this.backgroundColor = undefined
  }

  private paintDecorations(cell: RenderCell, colors: CanvasCellColors, x: number, y: number): void {
    const style = cell.style
    if (!style || (!style.overline && !style.strikethrough && style.underline <= 0)) return
    this.flushBackground(y)
    this.setFill(this.colors.foreground(colors))
    if (style.overline) this.context.fillRect(x, y + 1, this.font.deviceCellWidth, 1)
    if (style.strikethrough) {
      const offset = Math.floor(this.font.deviceCellHeight * 0.52)
      this.context.fillRect(x, y + offset, this.font.deviceCellWidth, 1)
    }
    drawUnderline(this.context, style.underline, x, y, this.font)
  }

  private paintCursor(
    cursor: CursorState | undefined,
    colors: CanvasCellColors,
    x: number,
    y: number,
  ): void {
    if (!cursor || cursor.style === 'block') return
    this.flushBackground(y)
    this.setFill(this.colors.foreground(colors))
    if (cursor.style === 'bar') {
      const width = Math.max(1, Math.floor(this.font.deviceCellWidth * 0.15))
      this.context.fillRect(x, y, width, this.font.deviceCellHeight)
      return
    }
    if (cursor.style === 'underline') {
      const height = Math.max(1, Math.floor(this.font.deviceCellHeight * 0.16))
      const lower = y + this.font.deviceCellHeight - height
      this.context.fillRect(x, lower, this.font.deviceCellWidth, height)
      return
    }
    drawOutlineCursor(this.context, x, y, this.font)
  }

  private paintGlyph(row: RenderRow, index: number): void {
    const cell = row.cells[index]!
    if (cell.continuation || !cell.text || cell.style?.invisible) return
    const span = cellSpan(row.cells, index)
    const deviceSpacing = this.font.deviceCellWidth - this.font.deviceCharWidth
    const characterWidth = this.font.deviceCellWidth * span - deviceSpacing
    const x = cell.x * this.font.deviceCellWidth + this.font.charLeft + characterWidth / 2
    const y = row.y * this.font.deviceCellHeight + this.font.deviceBaseline
    const style = Number(cell.style?.bold ?? false) + Number(cell.style?.italic ?? false) * 2
    this.setFont(this.fonts[style]!)
    this.setFill(this.colors.foreground(this.cellColors[index]!))
    this.setAlpha(cell.style?.faint ? 0.5 : 1)
    this.context.fillText(cell.text, x, y)
  }

  private setAlpha(value: number): void {
    if (this.currentAlpha === value) return
    this.context.globalAlpha = value
    this.currentAlpha = value
  }

  private setFill(value: string): void {
    if (this.currentFill === value) return
    this.context.fillStyle = value
    this.currentFill = value
  }

  private setFont(value: string): void {
    if (this.currentFont === value) return
    this.context.font = value
    this.currentFont = value
  }
}

function drawUnderline(
  context: Canvas2dContext,
  style: number,
  x: number,
  y: number,
  font: TerminalFittedFont,
): void {
  if (style <= 0) return
  const lower = y + font.deviceCellHeight - 2
  if (style === 1) {
    context.fillRect(x, lower, font.deviceCellWidth, 1)
    return
  }
  if (style === 2) {
    context.fillRect(x, lower, font.deviceCellWidth, 1)
    context.fillRect(x, lower - 3, font.deviceCellWidth, 1)
    return
  }
  if (style === 3) {
    drawWavyUnderline(context, x, lower, font.deviceCellWidth)
    return
  }
  drawPatternUnderline(context, x, lower, font.deviceCellWidth, style === 4)
}

function drawWavyUnderline(context: Canvas2dContext, x: number, y: number, width: number): void {
  context.beginPath()
  for (let offset = 0; offset < width; offset += 1) {
    const targetY = y - 1 + Math.sin(offset * (Math.PI / 2))
    if (offset === 0) context.moveTo(x, targetY)
    if (offset > 0) context.lineTo(x + offset, targetY)
  }
  context.lineWidth = 1
  context.strokeStyle = context.fillStyle
  context.stroke()
}

function drawPatternUnderline(
  context: Canvas2dContext,
  x: number,
  y: number,
  width: number,
  dotted: boolean,
): void {
  context.save()
  context.beginPath()
  context.setLineDash(dotted ? [2, 2] : [5, 3])
  context.moveTo(x, y + 0.5)
  context.lineTo(x + width, y + 0.5)
  context.lineWidth = 1
  context.strokeStyle = context.fillStyle
  context.stroke()
  context.restore()
}

function drawOutlineCursor(
  context: Canvas2dContext,
  x: number,
  y: number,
  font: TerminalFittedFont,
): void {
  const thickness = Math.max(
    1,
    Math.floor(Math.min(font.deviceCellWidth, font.deviceCellHeight) * 0.08),
  )
  context.strokeStyle = context.fillStyle
  context.lineWidth = thickness
  const inset = thickness / 2
  context.strokeRect(
    x + inset,
    y + inset,
    font.deviceCellWidth - thickness,
    font.deviceCellHeight - thickness,
  )
}
