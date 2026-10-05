import { FrameObserver } from './frame-observer.js'
import { RenderStateDirty } from '../core/abi.js'
import type { RenderCursorSnapshot, RenderRow } from '../core/types.js'
import type { TerminalFittedFont } from '../term/types.js'
import {
  browserRenderClock,
  canonicalRendererTheme,
  copyFittedFont,
  fittedFontsEqual,
  mergeRendererTheme,
  normalizeRendererGrid,
  safeRendererInteger,
} from './config.js'
import { renderCursorState, type InactiveCursorStyle } from './cursor.js'
import type { CanonicalRendererTheme, CursorState, RendererTheme } from './instances/types.js'
import type {
  RendererGridSize,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from './renderer.js'
import { RenderScheduler } from './scheduler.js'
export interface RowRendererMetrics {
  paintedCells: number
  paintedRows: number
  submittedFrames: number
}

export type RowThemeInvalidation = 'all' | 'cursor'

export interface RowRendererSurface {
  beginFrame?(): void
  dispose(): void
  paint(row: RenderRow, cursor: CursorState | undefined): void
  resize(font: TerminalFittedFont, grid: RendererGridSize): void
  setTheme(theme: CanonicalRendererTheme): RowThemeInvalidation
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

export class RowTerminalRenderer {
  private cursor?: RenderCursorSnapshot
  private cursorBlinkPreference: boolean
  private cursorPhaseVisible = true
  private disposed = false
  private focused = false
  private font: TerminalFittedFont
  private grid: RendererGridSize
  private inactiveCursorStyle?: InactiveCursorStyle
  readonly metrics: RowRendererMetrics = {
    paintedCells: 0,
    paintedRows: 0,
    submittedFrames: 0,
  }
  private needsFullRebuild = true
  private readonly frames: FrameObserver
  private readonly overlayRows = new Set<number>()
  private readonly renderState: RenderStateSource
  private readonly scheduler: RenderScheduler
  private theme: CanonicalRendererTheme
  private themeInput: RendererTheme

  constructor(
    options: WebGpuTerminalRendererOptions,
    private readonly surface: RowRendererSurface,
  ) {
    this.cursorBlinkPreference = options.cursorBlink ?? false
    this.font = copyFittedFont(options.font)
    this.grid = normalizeRendererGrid({
      columns: options.columns,
      rows: options.rows,
    })
    this.frames = new FrameObserver(options)
    this.renderState = options.renderState
    this.themeInput = mergeRendererTheme(options.theme)
    this.theme = canonicalRendererTheme(this.themeInput)
    this.surface.setTheme(this.theme)
    this.frames.resize(this.grid.rows)
    this.resizeCanvas()
    this.scheduler = new RenderScheduler({
      clock: options.schedulerClock ?? browserRenderClock(),
      onFrame: () => this.drawFrame(),
    })
    this.scheduler.schedule()
  }

  get canPaint(): boolean {
    return this.scheduler.canPaint
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
    this.surface.resize(next, this.grid)
    this.font = next
    this.frames.resize(this.grid.rows)
    this.invalidateAll()
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.themeInput = mergeRendererTheme({ ...this.themeInput, ...theme })
    this.theme = canonicalRendererTheme(this.themeInput)
    if (this.surface.setTheme(this.theme) === 'cursor') {
      const y = Math.max(0, Math.min(this.grid.rows - 1, this.cursor?.viewport?.y ?? 0))
      this.refreshRows(y, y)
      return
    }
    this.invalidateAll()
  }

  resize(grid: RendererGridSize): void {
    const next = normalizeRendererGrid(grid)
    if (this.gridEquals(next)) return
    this.grid = next
    this.resizeCanvas()
    this.frames.resize(this.grid.rows)
    this.overlayRows.clear()
    this.repaintNow()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scheduler.dispose()
    this.surface.dispose()
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
    if (rows.length === 0) {
      if (damage === RenderStateDirty.False && !this.needsFullRebuild)
        this.frames.notifyCleanUpdate()
      return
    }
    const style = this.focused ? undefined : this.inactiveCursorStyle
    const cursorState = renderCursorState(this.cursor, this.cursorPhaseVisible, style)
    this.surface.beginFrame?.()
    for (const row of rows) this.paintRow(row, cursorState)
    if (damage !== RenderStateDirty.False) this.renderState.acknowledge()
    this.metrics.paintedRows += rows.length
    this.metrics.submittedFrames += 1
    this.needsFullRebuild = false
    this.overlayRows.clear()
    this.emitFrame(rows)
  }

  private emitFrame(
    rows: readonly RenderRow[] | undefined,
    changed = rows?.map((row) => row.y) ?? [],
  ): void {
    if (!this.cursor) return
    this.frames.emit(
      this.renderState,
      this.cursor,
      renderCursorState(
        this.cursor,
        this.cursorPhaseVisible,
        this.focused ? undefined : this.inactiveCursorStyle,
      ),
      changed,
      rows,
    )
  }

  private gridEquals(grid: RendererGridSize): boolean {
    return this.grid.columns === grid.columns && this.grid.rows === grid.rows
  }

  private invalidateAll(): void {
    this.needsFullRebuild = true
    this.scheduler.schedule()
  }

  // Assigning the canvas size wiped the backbuffer; a scheduled frame would
  // present it empty once before repainting.
  private repaintNow(): void {
    this.needsFullRebuild = true
    this.scheduler.flush()
  }

  private paintRow(row: RenderRow, cursor: CursorState | undefined): void {
    if (row.y < 0 || row.y >= this.grid.rows) return
    this.surface.paint(row, cursor)
    this.metrics.paintedCells += row.cells.length
  }

  private resetCursorBlink(): void {
    this.scheduler.setCursorBlinkEnabled(false)
    this.synchronizeCursorBlink()
  }

  private resizeCanvas(): void {
    this.surface.resize(this.font, this.grid)
  }

  private rowsToPaint(damage: RenderStateDirty): readonly RenderRow[] {
    if (this.needsFullRebuild) return this.renderState.readRows()
    const rows = new Map<number, RenderRow>()
    if (damage !== RenderStateDirty.False) {
      for (const row of this.renderState.readRows({ dirtyOnly: true })) rows.set(row.y, row)
    }
    if (this.overlayRows.size === 0) return [...rows.values()]
    const missing = new Set([...this.overlayRows].filter((row) => !rows.has(row)))
    if (missing.size === 0) return [...rows.values()]
    for (const row of this.renderState.readRows({ rows: missing })) {
      if (missing.has(row.y)) rows.set(row.y, row)
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
