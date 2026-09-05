import { RenderStateDirty } from '../../core/abi.js'
import type { RenderCursorSnapshot, RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { GlyphAtlas } from '../atlas/atlas.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import type { GlyphBitmap } from '../atlas/types.js'
import {
  browserRenderClock,
  canonicalRendererTheme,
  copyFittedFont,
  fittedFontGeometryEquals,
  fittedFontsEqual,
  mergeRendererTheme,
  normalizeRendererGrid,
  safeRendererInteger,
} from '../config.js'
import { renderCursorState, type InactiveCursorStyle } from '../cursor.js'
import { InstanceRows } from '../instances/rows.js'
import type {
  CanonicalRendererTheme,
  RendererTheme,
  RowInstanceUpdate,
} from '../instances/types.js'
import type {
  RendererFrameRow,
  RendererFrameSnapshot,
  RendererGridSize,
  RendererMetrics,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from '../renderer.js'
import { RenderScheduler } from '../scheduler.js'
import { WebGlTextPass } from './text-pass.js'

type ContextState =
  | { readonly kind: 'ready'; readonly pass: WebGlTextPass }
  | { readonly kind: 'lost' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'disposed' }

export interface WebGlTerminalRendererOptions extends WebGpuTerminalRendererOptions {
  onContextLost?: () => void
}

export class WebGlUnavailableError extends Error {
  constructor(message = 'Unable to create a WebGL2 canvas context') {
    super(message)
    this.name = 'WebGlUnavailableError'
  }
}

function requireContext(canvas: HTMLCanvasElement | OffscreenCanvas): WebGL2RenderingContext {
  const context = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: true,
    stencil: false,
  })
  if (context) return context
  throw new WebGlUnavailableError()
}

function cursorEquals(left: RenderCursorSnapshot, right: RenderCursorSnapshot): boolean {
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

function copiedFrameRow(row: RenderRow): RendererFrameRow {
  const cells = Object.freeze(row.cells.map((cell) => cell.text.slice()))
  const continuations = Object.freeze(row.cells.map((cell) => cell.continuation))
  const text = cells.map((cell, index) => (continuations[index] ? '' : cell || ' ')).join('')
  return Object.freeze({ cells, continuations, text, y: row.y })
}

export class WebGlTerminalRenderer {
  readonly backend = 'webgl2' as const
  readonly metrics: RendererMetrics = {
    atlasCacheHits: 0,
    atlasCacheMisses: 0,
    atlasEvictions: 0,
    atlasPages: 0,
    atlasUploadedBytes: 0,
    atlasUploadOperations: 0,
    deviceRestores: 0,
    draws: 0,
    instanceUploadOperations: 0,
    rebuiltRows: 0,
    submittedFrames: 0,
    uploadedBytes: 0,
  }
  private readonly atlas = new GlyphAtlas()
  private atlasUploadedBytesOffset = 0
  private atlasUploadOperationsOffset = 0
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private readonly context: WebGL2RenderingContext
  private cursor?: RenderCursorSnapshot
  private cursorBlinkPreference: boolean
  private cursorPhaseVisible = true
  private documentVisible = true
  private focused = false
  private font: TerminalFittedFont
  private grid: RendererGridSize
  private inactiveCursorStyle?: InactiveCursorStyle
  private instances: InstanceRows
  private needsFullRebuild = true
  private readonly onError?: (cause: unknown) => void
  private readonly onContextLost?: () => void
  private readonly onFrame?: (snapshot: RendererFrameSnapshot) => void
  private readonly overlayRows = new Set<number>()
  private rasterizer: CanvasGlyphRasterizer
  private readonly renderState: RenderStateSource
  private readonly scheduler: RenderScheduler
  private state: ContextState
  private theme: CanonicalRendererTheme
  private themeInput: RendererTheme
  private visibleRows: (RendererFrameRow | undefined)[]

  private constructor(
    options: WebGlTerminalRendererOptions,
    font: TerminalFittedFont,
    grid: RendererGridSize,
    context: WebGL2RenderingContext,
  ) {
    this.canvas = options.canvas
    this.context = context
    this.font = font
    this.grid = grid
    this.renderState = options.renderState
    this.onError = options.onError
    this.onContextLost = options.onContextLost
    this.onFrame = options.onFrame
    this.cursorBlinkPreference = options.cursorBlink ?? false
    this.themeInput = mergeRendererTheme(options.theme)
    this.theme = canonicalRendererTheme(this.themeInput)
    this.visibleRows = Array.from({ length: grid.rows })
    this.resizeCanvas()
    this.instances = this.createInstances()
    this.rasterizer = new CanvasGlyphRasterizer({ font })
    this.state = { kind: 'ready', pass: this.createTextPass() }
    this.scheduler = new RenderScheduler({
      clock: options.schedulerClock ?? browserRenderClock(),
      onFrame: () => this.drawFrame(),
    })
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost)
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
    this.scheduler.schedule()
  }

  static async create(options: WebGlTerminalRendererOptions): Promise<WebGlTerminalRenderer> {
    const font = copyFittedFont(options.font)
    const grid = normalizeRendererGrid({ columns: options.columns, rows: options.rows })
    const context = requireContext(options.canvas)
    try {
      return new WebGlTerminalRenderer(options, font, grid, context)
    } catch (cause) {
      context.getExtension('WEBGL_lose_context')?.loseContext()
      throw cause
    }
  }

  get hasPendingFrame(): boolean {
    return this.scheduler.hasPendingFrame
  }

  get hasPendingTimer(): boolean {
    return this.scheduler.hasPendingTimer
  }

  clearTextureAtlas(): void {
    this.atlas.invalidateAll()
    this.invalidateAll()
  }

  notifySelectionChange(): void {
    this.invalidateAll()
  }

  notifyScroll(): void {
    this.invalidateAll()
  }

  notifyWrite(): void {
    this.scheduler.setCursorBlinkEnabled(false)
    this.synchronizeCursorBlink()
    this.schedule()
  }

  refreshRows(startRow: number, endRow: number): void {
    const start = safeRendererInteger('startRow', startRow)
    const end = safeRendererInteger('endRow', endRow)
    if (start > end) throw new RangeError('startRow must not exceed endRow')
    if (end >= this.grid.rows)
      throw new RangeError('endRow must be less than the renderer row count')
    for (let row = start; row <= end; row += 1) this.overlayRows.add(row)
    this.schedule()
  }

  schedule(): void {
    if (this.state.kind === 'unavailable') {
      this.scheduler.setDocumentVisible(this.documentVisible)
    }
    this.scheduler.schedule()
  }

  setCursorBlinkEnabled(enabled: boolean): void {
    if (this.cursorBlinkPreference === enabled) return
    this.cursorBlinkPreference = enabled
    this.synchronizeCursorBlink()
    this.schedule()
  }

  setDocumentVisible(visible: boolean): void {
    this.documentVisible = visible
    this.scheduler.setDocumentVisible(
      visible && (this.state.kind === 'ready' || this.state.kind === 'unavailable'),
    )
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.addCursorRow(this.cursor)
    this.focused = focused
    this.scheduler.setFocused(focused)
    this.schedule()
  }

  setInactiveCursorStyle(style: InactiveCursorStyle | undefined): void {
    if (this.inactiveCursorStyle === style) return
    this.addCursorRow(this.cursor)
    this.inactiveCursorStyle = style
    this.schedule()
  }

  setFont(font: TerminalFittedFont): void {
    const next = copyFittedFont(font)
    if (fittedFontsEqual(this.font, next)) return
    const geometryChanged = !fittedFontGeometryEquals(this.font, next)
    this.font = next
    if (geometryChanged) this.rebuildGeometry()
    this.rasterizer = new CanvasGlyphRasterizer({ font: next })
    this.clearTextureAtlas()
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.themeInput = mergeRendererTheme({ ...this.themeInput, ...theme })
    this.theme = canonicalRendererTheme(this.themeInput)
    this.invalidateAll()
  }

  resize(grid: RendererGridSize): void {
    const next = normalizeRendererGrid(grid)
    if (this.grid.columns === next.columns && this.grid.rows === next.rows) return
    for (let row = next.rows; row < this.grid.rows; row += 1) this.atlas.beginRow(row)
    this.grid = next
    this.rebuildGeometry()
    this.invalidateAll()
  }

  async capturePixels(): Promise<Uint8Array> {
    if (this.state.kind !== 'ready' || this.context.isContextLost()) {
      throw new Error('WebGL2 rendering context is unavailable')
    }
    return this.state.pass.capturePixels()
  }

  dispose(): void {
    if (this.state.kind === 'disposed') return
    this.scheduler.dispose()
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored)
    if (this.state.kind === 'ready') this.state.pass.destroy()
    this.state = { kind: 'disposed' }
    this.overlayRows.clear()
    this.context.getExtension('WEBGL_lose_context')?.loseContext()
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault()
    this.suspendContext()
  }

  private readonly handleContextRestored = (): void => {
    if (this.state.kind !== 'lost') return
    this.state = { kind: 'unavailable' }
    this.schedule()
  }

  private restoreContext(): void {
    try {
      this.state = { kind: 'ready', pass: this.createTextPass() }
    } catch (cause) {
      this.scheduler.setDocumentVisible(false)
      this.onError?.(cause)
      return
    }
    this.atlas.markAllForUpload()
    this.needsFullRebuild = true
    this.metrics.deviceRestores += 1
  }

  private suspendContext(): void {
    if (this.state.kind === 'disposed' || this.state.kind === 'lost') return
    if (this.state.kind === 'ready') {
      this.atlasUploadedBytesOffset += this.state.pass.atlasUploadedBytes
      this.atlasUploadOperationsOffset += this.state.pass.atlasUploadOperations
      this.state.pass.destroy()
    }
    this.state = { kind: 'lost' }
    this.scheduler.setDocumentVisible(false)
    this.onContextLost?.()
  }

  private createTextPass(): WebGlTextPass {
    return new WebGlTextPass({
      atlasLayout: this.atlas.textureLayout,
      context: this.context,
      height: this.canvas.height,
      instanceCount: this.grid.columns * this.grid.rows,
      width: this.canvas.width,
    })
  }

  private createInstances(): InstanceRows {
    return new InstanceRows({
      cellHeight: this.font.deviceCellHeight,
      cellWidth: this.font.deviceCellWidth,
      columns: this.grid.columns,
      rows: this.grid.rows,
    })
  }

  private rebuildGeometry(): void {
    this.resizeCanvas()
    this.instances = this.createInstances()
    if (this.state.kind === 'ready') {
      this.state.pass.resize({
        height: this.canvas.height,
        instanceCount: this.grid.columns * this.grid.rows,
        width: this.canvas.width,
      })
    }
    this.visibleRows = Array.from({ length: this.grid.rows })
    this.overlayRows.clear()
  }

  private resizeCanvas(): void {
    this.canvas.width = this.grid.columns * this.font.deviceCellWidth
    this.canvas.height = this.grid.rows * this.font.deviceCellHeight
    if (!('style' in this.canvas)) return
    this.canvas.style.width = `${this.grid.columns * this.font.cssCellWidth}px`
    this.canvas.style.height = `${this.grid.rows * this.font.cssCellHeight}px`
  }

  private drawFrame(): void {
    if (this.state.kind === 'unavailable' && this.context.isContextLost()) {
      return this.suspendContext()
    }
    if (this.state.kind === 'unavailable') this.restoreContext()
    if (this.state.kind !== 'ready') return
    if (this.context.isContextLost()) return this.suspendContext()
    const pass = this.state.pass
    const damage = this.renderState.update()
    const cursor = this.renderState.readCursor()
    this.updateCursor(cursor)
    this.synchronizeCursorBlink()
    const phaseVisible = this.scheduler.cursorVisible
    if (this.cursorPhaseVisible !== phaseVisible) this.addCursorRow(cursor)
    this.cursorPhaseVisible = phaseVisible
    const rows = this.rowsToRebuild(damage)
    if (rows.length === 0) return
    const updates = this.rebuildRows(rows)
    if (updates.some((update) => update.invalidatedRows.length > 0)) {
      this.invalidateAll()
      return
    }
    pass.syncAtlas(this.atlas.consumeUploads())
    const operations = pass.upload(this.instances, updates)
    pass.submit()
    if (this.context.isContextLost()) return this.suspendContext()
    if (damage !== RenderStateDirty.False) this.renderState.acknowledge()
    for (const row of rows) this.visibleRows[row.y] = copiedFrameRow(row)
    this.recordFrame(pass, updates, operations)
    this.needsFullRebuild = false
    this.overlayRows.clear()
    this.emitFrame()
  }

  private rebuildRows(rows: readonly RenderRow[]): readonly RowInstanceUpdate[] {
    const updates: RowInstanceUpdate[] = []
    const style = this.focused ? undefined : this.inactiveCursorStyle
    const cursor = renderCursorState(this.cursor, this.cursorPhaseVisible, style)
    const lookup = {
      beginRow: (row: number) => this.atlas.beginRow(row),
      resolve: (key: string, bitmap: GlyphBitmap, row: number) =>
        this.atlas.getOrInsert(key, bitmap, row),
    }
    for (const row of rows) {
      updates.push(this.instances.rebuildRow(row, lookup, this.rasterizer, this.theme, cursor))
    }
    return updates
  }

  private rowsToRebuild(damage: RenderStateDirty): readonly RenderRow[] {
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

  private addCursorRow(cursor: RenderCursorSnapshot | undefined): void {
    const row = cursor?.viewport?.y
    if (row === undefined || row < 0 || row >= this.grid.rows) return
    this.overlayRows.add(row)
  }

  private updateCursor(cursor: RenderCursorSnapshot): void {
    if (this.cursor && cursorEquals(this.cursor, cursor)) return
    this.addCursorRow(this.cursor)
    this.addCursorRow(cursor)
    this.cursor = cursor
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

  private invalidateAll(): void {
    this.needsFullRebuild = true
    this.schedule()
  }

  private recordFrame(
    pass: WebGlTextPass,
    updates: readonly RowInstanceUpdate[],
    operations: number,
  ): void {
    this.metrics.atlasCacheHits = this.atlas.cacheHitCount
    this.metrics.atlasCacheMisses = this.atlas.cacheMissCount
    this.metrics.atlasEvictions = this.atlas.evictionCount
    this.metrics.atlasPages = this.atlas.pageCount
    this.metrics.atlasUploadedBytes = this.atlasUploadedBytesOffset + pass.atlasUploadedBytes
    this.metrics.atlasUploadOperations =
      this.atlasUploadOperationsOffset + pass.atlasUploadOperations
    this.metrics.draws += 2
    this.metrics.instanceUploadOperations += operations
    this.metrics.rebuiltRows += updates.length
    this.metrics.submittedFrames += 1
    for (const update of updates) {
      this.metrics.uploadedBytes += update.cell.byteLength + update.glyph.byteLength
    }
  }

  private emitFrame(): void {
    if (!this.onFrame || !this.cursor) return
    const viewport = this.cursor.viewport ? Object.freeze({ ...this.cursor.viewport }) : undefined
    const cursor = Object.freeze({ ...this.cursor, viewport })
    const rows = this.visibleRows.filter((row): row is RendererFrameRow => row !== undefined)
    this.onFrame(Object.freeze({ cursor, rows: Object.freeze(rows) }))
  }
}
