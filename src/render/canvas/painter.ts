import { contrastAdjustedColor } from '../contrast.js'
import type { PaintTarget } from './paint-target.js'
import type { RenderCell, RenderRow } from '../../core/types.js'
import { emptyRenderCell } from '../../core/packed-cells.js'
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

interface PlainRowImage {
  readonly text: string
  readonly cursor: string
}

export function plainRowText(row: RenderRow): string | undefined {
  const packed = row.packed
  const cells = packed ? undefined : row.cells
  const length = packed?.length ?? cells!.length
  const scratch = packed ? emptyRenderCell() : undefined
  let text = ''
  for (let index = 0; index < length; index += 1) {
    const cell = packed ? packed.read(index, scratch!) : cells![index]!
    if (
      cell.x !== index ||
      cell.continuation ||
      cell.selected ||
      cell.background ||
      cell.foreground
    )
      return undefined
    const style = cell.style
    if (
      style &&
      (style.bold ||
        style.italic ||
        style.faint ||
        style.invisible ||
        style.inverse ||
        style.overline ||
        style.strikethrough ||
        style.underline > 0)
    )
      return undefined
    if (cell.text.length > 1) return undefined
    const code = cell.text.charCodeAt(0)
    if (cell.text && (code < 32 || code > 126)) return undefined
    text += cell.text || '\u0000'
  }
  return text
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
  private readonly plainRows = new Map<number, PlainRowImage>()
  private overhangLeft = 0
  private overhangRight = 0

  constructor(
    private readonly context: PaintTarget,
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
    this.invalidate()
    this.overhangLeft = 0
    this.overhangRight = 0
    if (!this.context.measureText) return
    const center = font.charLeft + font.deviceCharWidth / 2
    for (let code = 32; code <= 126; code += 1) {
      const ink = this.context.measureText(String.fromCharCode(code))
      this.overhangLeft = Math.max(this.overhangLeft, Math.ceil(ink.actualBoundingBoxLeft - center))
      this.overhangRight = Math.max(
        this.overhangRight,
        Math.ceil(center + ink.actualBoundingBoxRight - font.deviceCellWidth),
      )
    }
  }

  invalidate(): void {
    this.plainRows.clear()
  }

  setTheme(theme: CanonicalRendererTheme): void {
    this.theme = theme
    this.colors = new CanvasColorCache(theme.minimumContrast)
    this.invalidate()
  }

  paint(
    row: RenderRow,
    cursor: CursorState | undefined,
    width: number,
    allowCellDamage = true,
    capturedPlainText?: string,
  ): void {
    const damage = allowCellDamage
      ? this.plainDamage(row, cursor, width, capturedPlainText)
      : undefined
    const plain = damage !== undefined && !this.context.glyph
    if (!allowCellDamage) this.plainRows.delete(row.y)
    if (damage && damage.width === 0) return
    const x = damage?.x ?? 0
    const paintWidth = damage?.width ?? width
    if (damage && !plain) {
      const packed = row.packed
      const cells = packed
        ? Array.from({ length: damage.end - damage.first }, (_, index) =>
            packed.read(damage.first + index, emptyRenderCell()),
          )
        : row.cells.slice(damage.first, damage.end)
      // Spreading the source row would invoke its complete-cell getter.
      row = { y: row.y, dirty: row.dirty, cells }
    }
    const y = row.y * this.font.deviceCellHeight
    this.currentFill = undefined
    this.currentFont = this.fonts[0]
    this.currentAlpha = 1
    if (!plain) this.cellColors.length = row.cells.length
    this.context.save()
    this.context.beginPath()
    this.context.rect(x, y, paintWidth, this.font.deviceCellHeight)
    this.context.clip()
    this.context.clearRect(x, y, paintWidth, this.font.deviceCellHeight)
    if (plain) {
      this.paintPlain(damage.text, cursor, row.y, damage.first, damage.end)
      this.context.restore()
      return
    }
    this.paintBackgrounds(row, cursor, y)
    for (let index = 0; index < row.cells.length;) index += this.paintGlyph(row, index)
    this.context.restore()
  }

  private plainDamage(
    row: RenderRow,
    cursor: CursorState | undefined,
    width: number,
    capturedPlainText?: string,
  ): { x: number; width: number; first: number; end: number; text: string } | undefined {
    if (!this.context.measureText || !Number.isInteger(this.font.deviceCellWidth)) return undefined
    const text = capturedPlainText ?? plainRowText(row)
    if (text === undefined) {
      this.plainRows.delete(row.y)
      return undefined
    }
    const cellWidth = this.font.deviceCellWidth
    const currentCursor = cursor?.visible && cursor.y === row.y ? `${cursor.x}:${cursor.style}` : ''
    const previous = this.plainRows.get(row.y)
    this.plainRows.set(row.y, { text, cursor: currentCursor })
    if (!previous || previous.text.length !== text.length) return undefined
    let first = 0
    let end = text.length
    while (first < end && previous.text[first] === text[first]) first += 1
    while (end > first && previous.text[end - 1] === text[end - 1]) end -= 1
    if (first === end) end = 0
    if (previous.cursor !== currentCursor) {
      for (const value of [previous.cursor, currentCursor]) {
        if (!value) continue
        const column = Number(value.split(':')[0])
        first = Math.min(first, column)
        end = Math.max(end, column + 1)
      }
    }
    if (end <= first) return { x: 0, width: 0, first: 0, end: 0, text }
    const left = Math.max(0, first * cellWidth - this.overhangLeft)
    const right = Math.min(width, end * cellWidth + this.overhangRight)
    // Unchanged neighboring ink can cross the clear region and must be restored too.
    const glyphFirst = Math.max(0, Math.floor((left - this.overhangRight) / cellWidth))
    const glyphEnd = Math.min(text.length, Math.ceil((right + this.overhangLeft) / cellWidth))
    return { x: left, width: right - left, first: glyphFirst, end: glyphEnd, text }
  }

  private paintPlain(
    text: string,
    cursor: CursorState | undefined,
    row: number,
    first: number,
    end: number,
  ): void {
    const cell = emptyRenderCell()
    const colors = resolveCanvasCellColors(cell, this.theme, false)
    const activeCursor =
      cursor?.visible && cursor.y === row && cursor.x >= first && cursor.x < end
        ? cursor
        : undefined
    const cursorColors = activeCursor
      ? resolveCanvasCellColors(cell, this.theme, activeCursor.style === 'block')
      : colors
    const y = row * this.font.deviceCellHeight
    if (activeCursor) {
      const x = activeCursor.x * this.font.deviceCellWidth
      this.appendBackground(cursorColors, x, y)
      this.paintCursor(activeCursor, cursorColors, x, y)
    }
    this.flushBackground(y)
    const foreground = this.colors.foreground(colors)
    const cursorForeground = this.colors.foreground(cursorColors)
    const deviceSpacing = this.font.deviceCellWidth - this.font.deviceCharWidth
    const characterWidth = this.font.deviceCellWidth - deviceSpacing
    for (let column = first; column < end; column += 1) {
      const glyph = text[column]!
      if (glyph === '\u0000') continue
      this.setFill(column === activeCursor?.x ? cursorForeground : foreground)
      const x = column * this.font.deviceCellWidth + this.font.charLeft + characterWidth / 2
      this.context.fillText(glyph, x, y + this.font.deviceBaseline)
    }
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

  private paintGlyph(row: RenderRow, index: number): number {
    const cell = row.cells[index]!
    if (cell.continuation || !cell.text || cell.style?.invisible) return 1
    const span = cellSpan(row.cells, index)
    const text = cell.text
    const deviceSpacing = this.font.deviceCellWidth - this.font.deviceCharWidth
    const characterWidth = this.font.deviceCellWidth * span - deviceSpacing
    const x = cell.x * this.font.deviceCellWidth + this.font.charLeft + characterWidth / 2
    const y = row.y * this.font.deviceCellHeight + this.font.deviceBaseline
    const style = Number(cell.style?.bold ?? false) + Number(cell.style?.italic ?? false) * 2
    this.setFont(this.fonts[style]!)
    this.setFill(this.colors.foreground(this.cellColors[index]!))
    this.setAlpha(cell.style?.faint ? 0.5 : 1)
    if (this.context.glyph) {
      const colors = this.cellColors[index]!
      const foreground =
        this.theme.minimumContrast > 1
          ? contrastAdjustedColor(colors.foreground, colors.background, this.theme.minimumContrast)
          : colors.foreground
      this.context.glyph(
        {
          cellSpan: span,
          foreground,
          italic: cell.style?.italic ?? false,
          text,
          weight: cell.style?.bold ? 'bold' : 'normal',
        },
        cell.x * this.font.deviceCellWidth,
        row.y * this.font.deviceCellHeight,
      )
    } else {
      this.context.fillText(text, x, y)
    }
    return span
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
  context: PaintTarget,
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

function drawWavyUnderline(context: PaintTarget, x: number, y: number, width: number): void {
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
  context: PaintTarget,
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
  context: PaintTarget,
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
