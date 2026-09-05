import { RenderStateDirty } from '../../core/abi.js'
import type { RenderCell, RenderCursorSnapshot, RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import {
  browserRenderClock,
  canonicalRendererTheme,
  copyFittedFont,
  fittedFontsEqual,
  mergeRendererTheme,
  normalizeRendererGrid,
  safeRendererInteger,
} from '../config.js'
import { renderCursorState, type InactiveCursorStyle } from '../cursor.js'
import type { CanonicalRendererTheme, CursorState, RendererTheme } from '../instances/types.js'
import type {
  RendererFrameRow,
  RendererFrameSnapshot,
  RendererGridSize,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from '../renderer.js'
import { RenderScheduler } from '../scheduler.js'
import {
  contrastAdjustedColor,
  cssRgb,
  resolveCanvasCellColors,
  type CanvasCellColors,
} from './colors.js'

type Canvas2dContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface CanvasRendererMetrics {
  paintedCells: number
  paintedRows: number
  submittedFrames: number
}

function requireContext(canvas: HTMLCanvasElement | OffscreenCanvas): Canvas2dContext {
  const context = canvas.getContext('2d', { alpha: true }) as Canvas2dContext | null
  if (context) return context
  throw new TypeError('Canvas 2D is unavailable')
}

function cursorSnapshotsEqual(left: RenderCursorSnapshot, right: RenderCursorSnapshot): boolean {
  if (left.blinking !== right.blinking) return false
  if (left.passwordInput !== right.passwordInput) return false
  if (left.style !== right.style) return false
  if (left.visible !== right.visible) return false
  if (!left.viewport || !right.viewport) return left.viewport === right.viewport
  return (
    left.viewport.wideTail === right.viewport.wideTail &&
    left.viewport.x === right.viewport.x &&
    left.viewport.y === right.viewport.y
  )
}

function copiedCursor(cursor: RenderCursorSnapshot): Readonly<RenderCursorSnapshot> {
  const viewport = cursor.viewport ? Object.freeze({ ...cursor.viewport }) : undefined
  return Object.freeze({ ...cursor, viewport })
}

function copiedFrameRow(row: RenderRow): RendererFrameRow {
  const cells = Object.freeze(row.cells.map((cell) => cell.text.slice()))
  const continuations = Object.freeze(row.cells.map((cell) => cell.continuation))
  const text = cells.map((cell, index) => (continuations[index] ? '' : cell || ' ')).join('')
  return Object.freeze({ cells, continuations, text, y: row.y })
}

function fontString(font: TerminalFittedFont, cell: RenderCell): string {
  const italic = cell.style?.italic ? 'italic ' : ''
  const weight = cell.style?.bold ? font.settings.boldWeight : font.settings.weight
  return `${italic}${weight} ${font.settings.size * font.pixelRatio}px ${font.settings.family}`
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

function drawCellBackground(
  context: Canvas2dContext,
  cell: RenderCell,
  row: number,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  cursor: CursorState | undefined,
): void {
  const colors = resolveCanvasCellColors(cell, theme, cursor?.style === 'block')
  const x = cell.x * font.deviceCellWidth
  const y = row * font.deviceCellHeight
  if (colors.drawBackground) {
    context.fillStyle = cssRgb(colors.background)
    context.fillRect(x, y, font.deviceCellWidth, font.deviceCellHeight)
  }
  drawCellDecorations(context, cell, x, y, font, theme, colors)
  drawCursor(context, cursor, x, y, font, theme, colors)
}

function drawCellDecorations(
  context: Canvas2dContext,
  cell: RenderCell,
  x: number,
  y: number,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  colors: CanvasCellColors,
): void {
  const style = cell.style
  if (!style) return
  const color = contrastAdjustedColor(colors.foreground, colors.background, theme.minimumContrast)
  context.fillStyle = cssRgb(color)
  if (style.overline) context.fillRect(x, y + 1, font.deviceCellWidth, 1)
  if (style.strikethrough) {
    context.fillRect(x, y + Math.floor(font.deviceCellHeight * 0.52), font.deviceCellWidth, 1)
  }
  drawUnderline(context, style.underline, x, y, font)
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

function drawCursor(
  context: Canvas2dContext,
  cursor: CursorState | undefined,
  x: number,
  y: number,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  colors: CanvasCellColors,
): void {
  if (!cursor || cursor.style === 'block') return
  const color = contrastAdjustedColor(colors.foreground, colors.background, theme.minimumContrast)
  context.fillStyle = cssRgb(color)
  if (cursor.style === 'bar') {
    const width = Math.max(1, Math.floor(font.deviceCellWidth * 0.15))
    context.fillRect(x, y, width, font.deviceCellHeight)
    return
  }
  if (cursor.style === 'underline') {
    const height = Math.max(1, Math.floor(font.deviceCellHeight * 0.16))
    context.fillRect(x, y + font.deviceCellHeight - height, font.deviceCellWidth, height)
    return
  }
  drawOutlineCursor(context, x, y, font)
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

function drawCellGlyph(
  context: Canvas2dContext,
  cells: readonly RenderCell[],
  index: number,
  row: number,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  cursorState: CursorState | undefined,
): void {
  const cell = cells[index]
  if (!cell || cell.continuation || !cell.text || cell.style?.invisible) return
  const cursor = cursorForCell(cursorState, cell, row)
  const colors = resolveCanvasCellColors(cell, theme, cursor?.style === 'block')
  const foreground = contrastAdjustedColor(
    colors.foreground,
    colors.background,
    theme.minimumContrast,
  )
  const span = cellSpan(cells, index)
  const deviceSpacing = font.deviceCellWidth - font.deviceCharWidth
  const characterWidth = font.deviceCellWidth * span - deviceSpacing
  const x = cell.x * font.deviceCellWidth + font.charLeft + characterWidth / 2
  const y = row * font.deviceCellHeight + font.deviceBaseline
  context.font = fontString(font, cell)
  context.fillStyle = cssRgb(foreground)
  context.globalAlpha = cell.style?.faint ? 0.5 : 1
  context.textAlign = 'center'
  context.textBaseline = 'alphabetic'
  context.fillText(cell.text, x, y)
  context.globalAlpha = 1
}

function paintBackgrounds(
  context: Canvas2dContext,
  row: RenderRow,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  cursor: CursorState | undefined,
): void {
  for (const cell of row.cells) {
    const cellCursor = cursorForCell(cursor, cell, row.y)
    drawCellBackground(context, cell, row.y, font, theme, cellCursor)
  }
}

function paintGlyphs(
  context: Canvas2dContext,
  row: RenderRow,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  cursor: CursorState | undefined,
): void {
  for (let index = 0; index < row.cells.length; index += 1) {
    drawCellGlyph(context, row.cells, index, row.y, font, theme, cursor)
  }
}

export class CanvasTerminalRenderer {
  readonly backend = 'canvas2d' as const
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private readonly context: Canvas2dContext
  private cursor?: RenderCursorSnapshot
  private cursorBlinkPreference: boolean
  private cursorPhaseVisible = true
  private disposed = false
  private focused = false
  private font: TerminalFittedFont
  private grid: RendererGridSize
  private inactiveCursorStyle?: InactiveCursorStyle
  readonly metrics: CanvasRendererMetrics = {
    paintedCells: 0,
    paintedRows: 0,
    submittedFrames: 0,
  }
  private needsFullRebuild = true
  private readonly onFrame?: (snapshot: RendererFrameSnapshot) => void
  private readonly overlayRows = new Set<number>()
  private readonly renderState: RenderStateSource
  private readonly scheduler: RenderScheduler
  private theme: CanonicalRendererTheme
  private themeInput: RendererTheme
  private visibleRows: (RendererFrameRow | undefined)[]

  private constructor(options: WebGpuTerminalRendererOptions) {
    this.canvas = options.canvas
    this.cursorBlinkPreference = options.cursorBlink ?? false
    this.font = copyFittedFont(options.font)
    this.grid = normalizeRendererGrid({ columns: options.columns, rows: options.rows })
    this.context = requireContext(options.canvas)
    this.onFrame = options.onFrame
    this.renderState = options.renderState
    this.themeInput = mergeRendererTheme(options.theme)
    this.theme = canonicalRendererTheme(this.themeInput)
    this.visibleRows = Array.from({ length: this.grid.rows })
    this.resizeCanvas()
    this.scheduler = new RenderScheduler({
      clock: options.schedulerClock ?? browserRenderClock(),
      onFrame: () => this.drawFrame(),
    })
    this.scheduler.schedule()
  }

  static create(options: WebGpuTerminalRendererOptions): Promise<CanvasTerminalRenderer> {
    return Promise.resolve(new CanvasTerminalRenderer(options))
  }

  get hasPendingFrame(): boolean {
    return this.scheduler.hasPendingFrame
  }

  get hasPendingTimer(): boolean {
    return this.scheduler.hasPendingTimer
  }

  clearTextureAtlas(): void {
    this.invalidateAll()
  }

  notifyScroll(): void {
    this.invalidateAll()
  }

  notifySelectionChange(): void {
    this.invalidateAll()
  }

  notifyWrite(): void {
    this.resetCursorBlink()
    this.scheduler.schedule()
  }

  refreshRows(startRow: number, endRow: number): void {
    const start = safeRendererInteger('startRow', startRow)
    const end = safeRendererInteger('endRow', endRow)
    if (start > end) throw new RangeError('startRow must not exceed endRow')
    if (end >= this.grid.rows) {
      throw new RangeError('endRow must be less than the renderer row count')
    }
    for (let row = start; row <= end; row += 1) this.overlayRows.add(row)
    this.scheduler.schedule()
  }

  schedule(): void {
    this.scheduler.schedule()
  }

  setCursorBlinkEnabled(enabled: boolean): void {
    if (this.cursorBlinkPreference === enabled) return
    this.cursorBlinkPreference = enabled
    this.synchronizeCursorBlink()
  }

  setDocumentVisible(visible: boolean): void {
    this.scheduler.setDocumentVisible(visible)
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.addCursorRow(this.cursor)
    this.focused = focused
    this.scheduler.setFocused(focused)
  }

  setInactiveCursorStyle(style: InactiveCursorStyle | undefined): void {
    if (this.inactiveCursorStyle === style) return
    this.addCursorRow(this.cursor)
    this.inactiveCursorStyle = style
    this.scheduler.schedule()
  }

  setFont(font: TerminalFittedFont): void {
    const next = copyFittedFont(font)
    if (fittedFontsEqual(this.font, next)) return
    this.font = next
    this.resizeCanvas()
    this.visibleRows = Array.from({ length: this.grid.rows })
    this.invalidateAll()
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.themeInput = mergeRendererTheme({ ...this.themeInput, ...theme })
    this.theme = canonicalRendererTheme(this.themeInput)
    this.invalidateAll()
  }

  resize(grid: RendererGridSize): void {
    const next = normalizeRendererGrid(grid)
    if (this.gridEquals(next)) return
    this.grid = next
    this.resizeCanvas()
    this.visibleRows = Array.from({ length: this.grid.rows })
    this.overlayRows.clear()
    this.invalidateAll()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scheduler.dispose()
    this.overlayRows.clear()
  }

  private addCursorRow(cursor: RenderCursorSnapshot | undefined): void {
    const row = cursor?.viewport?.y
    if (row === undefined) return
    if (row < 0 || row >= this.grid.rows) return
    this.overlayRows.add(row)
  }

  private drawFrame(): void {
    if (this.disposed) return
    const damage = this.renderState.update()
    const cursor = this.renderState.readCursor()
    this.updateCursor(cursor)
    this.synchronizeCursorBlink()
    const phaseVisible = this.scheduler.cursorVisible
    if (this.cursorPhaseVisible !== phaseVisible) this.addCursorRow(cursor)
    this.cursorPhaseVisible = phaseVisible
    const rows = this.rowsToPaint(damage)
    if (rows.length === 0) return
    const style = this.focused ? undefined : this.inactiveCursorStyle
    const cursorState = renderCursorState(this.cursor, this.cursorPhaseVisible, style)
    for (const row of rows) this.paintRow(row, cursorState)
    if (damage !== RenderStateDirty.False) this.renderState.acknowledge()
    for (const row of rows) this.visibleRows[row.y] = copiedFrameRow(row)
    this.metrics.paintedRows += rows.length
    this.metrics.submittedFrames += 1
    this.needsFullRebuild = false
    this.overlayRows.clear()
    this.emitFrame()
  }

  private emitFrame(): void {
    if (!this.onFrame || !this.cursor) return
    const rows = this.visibleRows.filter((row): row is RendererFrameRow => row !== undefined)
    this.onFrame(
      Object.freeze({
        cursor: copiedCursor(this.cursor),
        rows: Object.freeze([...rows]),
      }),
    )
  }

  private gridEquals(grid: RendererGridSize): boolean {
    return this.grid.columns === grid.columns && this.grid.rows === grid.rows
  }

  private invalidateAll(): void {
    this.needsFullRebuild = true
    this.scheduler.schedule()
  }

  private paintRow(row: RenderRow, cursor: CursorState | undefined): void {
    if (row.y < 0 || row.y >= this.grid.rows) return
    const y = row.y * this.font.deviceCellHeight
    this.context.save()
    this.context.beginPath()
    this.context.rect(0, y, this.canvas.width, this.font.deviceCellHeight)
    this.context.clip()
    this.context.clearRect(0, y, this.canvas.width, this.font.deviceCellHeight)
    paintBackgrounds(this.context, row, this.font, this.theme, cursor)
    paintGlyphs(this.context, row, this.font, this.theme, cursor)
    this.context.restore()
    this.metrics.paintedCells += row.cells.length
  }

  private resetCursorBlink(): void {
    this.scheduler.setCursorBlinkEnabled(false)
    this.synchronizeCursorBlink()
  }

  private resizeCanvas(): void {
    const logicalWidth = this.grid.columns * this.font.cssCellWidth
    const logicalHeight = this.grid.rows * this.font.cssCellHeight
    this.canvas.width = this.grid.columns * this.font.deviceCellWidth
    this.canvas.height = this.grid.rows * this.font.deviceCellHeight
    if (!('style' in this.canvas)) return
    this.canvas.style.width = `${logicalWidth}px`
    this.canvas.style.height = `${logicalHeight}px`
  }

  private rowsToPaint(damage: RenderStateDirty): readonly RenderRow[] {
    if (this.needsFullRebuild) return this.renderState.readRows()
    const rows = new Map<number, RenderRow>()
    if (damage !== RenderStateDirty.False) {
      for (const row of this.renderState.readRows({ dirtyOnly: true })) rows.set(row.y, row)
    }
    if (this.overlayRows.size === 0) return [...rows.values()]
    for (const row of this.renderState.readRows()) {
      if (this.overlayRows.has(row.y)) rows.set(row.y, row)
    }
    return [...rows.values()].sort((left, right) => left.y - right.y)
  }

  private synchronizeCursorBlink(): void {
    const cursor = this.cursor
    const enabled =
      this.cursorBlinkPreference &&
      (cursor?.blinking ?? false) &&
      (cursor?.visible ?? false) &&
      cursor?.viewport !== undefined
    this.scheduler.setCursorBlinkEnabled(enabled)
  }

  private updateCursor(cursor: RenderCursorSnapshot): void {
    const previous = this.cursor
    if (previous && cursorSnapshotsEqual(previous, cursor)) return
    this.addCursorRow(previous)
    this.addCursorRow(cursor)
    this.cursor = cursor
  }
}
