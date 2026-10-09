import { createGhosttyError } from '../../core/error.js'
import type { RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import type { CanonicalRendererTheme, CursorState } from '../instances/types.js'
import type {
  CanvasPaintMode,
  RendererGridSize,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from '../renderer.js'
import {
  RowTerminalRenderer,
  type RowRendererMetrics,
  type RowRendererSurface,
  type RowThemeInvalidation,
} from '../row-renderer.js'
import { CanvasRowPainter, plainRowText, type Canvas2dContext } from './painter.js'
import type { PixelTarget, PixelMetrics, PixelTargetFactory } from './pixel-target.js'
import { canvasScrollPlan, type CanvasScrollPlan } from './scroll.js'

export interface CanvasRendererMetrics
  extends RowRendererMetrics, CanvasReuseMetrics, PixelMetrics {}

/** Completed physical work accumulates for the renderer lifetime, including across invalidations. */
export interface CanvasReuseMetrics {
  /** Device rows transported by completed self-copies, including rows subsequently repainted. */
  copiedRows: number
  /** Row painter calls that returned successfully. */
  repaintedRows: number
  /** Overlap-copy operations that returned successfully. */
  selfCopies: number
}

interface PaintedImage {
  readonly keys: ReadonlyMap<number, string>
  readonly cursor: CursorState | undefined
}

function requireContext(canvas: HTMLCanvasElement | OffscreenCanvas): Canvas2dContext {
  // Explicit false avoids Chromium's automatic software fallback after incidental pixel reads.
  const context = canvas.getContext('2d', {
    alpha: true,
    willReadFrequently: false,
  }) as Canvas2dContext | null
  if (context) return context
  throw new CanvasUnavailableError()
}

export class CanvasUnavailableError extends TypeError {
  constructor() {
    super('Canvas 2D is unavailable')
    this.name = 'CanvasUnavailableError'
  }
}

function cursorKey(cursor: CursorState | undefined, y: number): string {
  if (!cursor?.visible || cursor.y !== y) return ''
  return `${cursor.x}:${cursor.style}`
}

class CanvasSurface implements RowRendererSurface {
  private readonly context: Canvas2dContext
  private readonly painter: CanvasRowPainter
  private readonly pixelTarget?: PixelTarget
  private image?: PaintedImage
  private capturing = false
  private pending = new Map<number, string>()
  private plan?: CanvasScrollPlan
  private nextImage?: PaintedImage
  private remaining = 0
  private rowHeight = 0
  private rowCount = 0
  private font: TerminalFittedFont
  contextLost = false
  reuseMetrics: CanvasReuseMetrics & PixelMetrics = {
    copiedRows: 0,
    repaintedRows: 0,
    selfCopies: 0,
    bufferMoves: 0,
    movedRows: 0,
    rasterReadbackBytes: 0,
    rowCopyBytes: 0,
    uploadedRegions: 0,
    uploadedPixelBytes: 0,
  }

  constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    options: WebGpuTerminalRendererOptions,
    targetFactory?: PixelTargetFactory,
  ) {
    this.font = options.font
    this.context = requireContext(canvas)
    this.pixelTarget = targetFactory?.(canvas, this.context)
    this.painter = new CanvasRowPainter(
      this.pixelTarget?.context ?? this.context,
      options.font,
      canonicalRendererTheme(mergeRendererTheme(options.theme)),
    )
  }

  useMetrics(metrics: CanvasRendererMetrics): void {
    this.reuseMetrics = Object.assign(metrics, this.reuseMetrics)
    if (this.pixelTarget) this.pixelTarget.metrics = this.reuseMetrics
  }

  source(source: RenderStateSource): RenderStateSource {
    return {
      get snapshotVersion() {
        return source.snapshotVersion
      },
      createFrameBuilder: source.createFrameBuilder?.bind(source),
      readTextRows: source.readTextRows?.bind(source),
      readCursor: () => source.readCursor(),
      acknowledge: () => source.acknowledge(),
      update: () => {
        this.pending = new Map()
        this.capturing = true
        return source.update()
      },
      readRows: (options) => {
        // Pixel identities and full-row painting share the same decoded cells.
        const rows = source.readRows({ ...options, packed: !this.pixelTarget })
        if (!this.capturing) return rows
        for (const row of rows) this.captureRow(row, options?.rows)
        return rows
      },
    }
  }

  private captureRow(row: RenderRow, requested?: ReadonlySet<number>): void {
    if (row.y < 0 || row.y >= this.rowCount) return
    if (requested && !requested.has(row.y)) return
    const text = plainRowText(row)
    if (text !== undefined) {
      this.pending.set(row.y, `plain:${text}`)
      return
    }
    this.pending.set(row.y, JSON.stringify(row.cells))
  }

  beginFrame(): void {
    this.capturing = false
    this.plan = undefined
    this.nextImage = undefined
    this.remaining = this.pending.size
  }

  dispose(): void {
    this.invalidate()
    this.pending.clear()
    this.pixelTarget?.dispose()
  }

  invalidate(): void {
    this.painter.invalidate()
    this.image = undefined
    this.nextImage = undefined
    this.plan = undefined
  }

  paint(row: RenderRow, cursor: CursorState | undefined): void {
    if (this.contextLost)
      throw createGhosttyError('canvas.context', 'Canvas 2D context is awaiting restoration')
    try {
      if (!this.plan) this.prepare(cursor)
      if (!this.canReuse(row.y, cursor)) {
        this.pixelTarget?.beginRow(row.y)
        const key = this.pending.get(row.y)
        const text = key?.startsWith('plain:') ? key.slice(6) : null
        this.painter.paint(
          row,
          cursor,
          this.canvas.width,
          (!this.pixelTarget || this.pixelTarget.cellDamage === true) &&
            this.pending.size === 1 &&
            this.plan!.offset === 0,
          text,
        )
        this.pixelTarget?.finishRow(row.y)
        this.reuseMetrics.repaintedRows += 1
      }
      this.remaining -= 1
      if (this.remaining === 0) {
        this.pixelTarget?.present()
        this.image = this.nextImage
      }
    } catch (cause) {
      // A partial copy/paint no longer corresponds to either complete snapshot.
      this.invalidate()
      throw cause
    }
  }

  resize(font: TerminalFittedFont, grid: RendererGridSize): void {
    this.invalidate()
    this.font = font
    this.rowHeight = font.deviceCellHeight
    this.rowCount = grid.rows
    this.canvas.width = grid.columns * font.deviceCellWidth
    this.canvas.height = grid.rows * font.deviceCellHeight
    this.pixelTarget?.resize(this.canvas.width, this.canvas.height, this.rowHeight)
    this.pixelTarget?.setFont?.(font)
    this.painter.resetContext(font)
    if (!('style' in this.canvas)) return
    this.canvas.style.width = `${grid.columns * font.cssCellWidth}px`
    this.canvas.style.height = `${grid.rows * font.cssCellHeight}px`
  }

  refreshFontResources(): void {
    this.painter.resetContext(this.font)
    this.pixelTarget?.invalidate?.()
  }

  setTheme(theme: CanonicalRendererTheme): RowThemeInvalidation {
    this.invalidate()
    this.painter.setTheme(theme)
    return 'all'
  }

  private prepare(cursor: CursorState | undefined): void {
    const previous = this.image?.keys ?? new Map<number, string>()
    const plan = canvasScrollPlan(previous, this.pending, this.rowCount)
    this.plan = Number.isInteger(this.rowHeight) ? plan : { offset: 0, reused: new Set() }
    const keys = new Map(previous)
    for (const [y, key] of this.pending) keys.set(y, key)
    this.nextImage = { keys, cursor: cursor ? { ...cursor } : undefined }
    if (this.plan.offset !== 0) {
      this.painter.invalidate()
      this.copyRows(this.plan.offset)
    }
  }

  private canReuse(y: number, cursor: CursorState | undefined): boolean {
    const plan = this.plan!
    if (!plan.reused.has(y)) return false
    const oldCursor = cursorKey(this.image?.cursor, y - plan.offset)
    const newCursor = cursorKey(cursor, y)
    if (plan.offset === 0) return oldCursor === newCursor
    // Transported cursor pixels and the current cursor stay screen-coordinate overlays.
    return oldCursor === '' && newCursor === ''
  }

  private copyRows(offset: number): void {
    const sourceY = Math.max(0, -offset) * this.rowHeight
    const targetY = Math.max(0, offset) * this.rowHeight
    const height = (this.rowCount - Math.abs(offset)) * this.rowHeight
    this.context.save()
    try {
      this.context.setTransform(1, 0, 0, 1, 0, 0)
      this.context.beginPath()
      this.context.rect(0, targetY, this.canvas.width, height)
      this.context.clip()
      this.context.globalAlpha = 1
      // Source-over would retain destination pixels beneath transparent source pixels.
      this.context.globalCompositeOperation = 'copy'
      this.context.imageSmoothingEnabled = false
      this.context.filter = 'none'
      this.context.drawImage(
        this.canvas,
        0,
        sourceY,
        this.canvas.width,
        height,
        0,
        targetY,
        this.canvas.width,
        height,
      )
    } finally {
      this.context.restore()
    }
    this.reuseMetrics.copiedRows += this.rowCount - Math.abs(offset)
    this.reuseMetrics.selfCopies += 1
    this.pixelTarget?.copyRows(offset)
  }
}

export class CanvasTerminalRenderer extends RowTerminalRenderer {
  readonly backend = 'canvas2d' as const
  declare readonly metrics: CanvasRendererMetrics
  readonly reuseMetrics: Readonly<CanvasReuseMetrics>
  readonly pixelMetrics: Readonly<PixelMetrics>
  readonly canvasPaintMode: CanvasPaintMode
  private readonly canvasSurface: CanvasSurface
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault()
    this.canvasSurface.contextLost = true
    this.canvasSurface.invalidate()
  }
  private readonly onContextRestored = (): void => {
    this.canvasSurface.contextLost = false
    this.clearTextureAtlas()
  }

  protected constructor(
    options: WebGpuTerminalRendererOptions,
    targetFactory?: PixelTargetFactory,
  ) {
    const mode = options.rendererMode === 'canvas2d-pixels' ? 'pixels' : 'fill-text'
    if (mode === 'pixels' && !targetFactory)
      throw createGhosttyError('canvas.pixels', 'Canvas pixel composition is unavailable')
    const surface = new CanvasSurface(
      options.canvas,
      options,
      mode === 'pixels' ? targetFactory : undefined,
    )
    super({ ...options, renderState: surface.source(options.renderState) }, surface)
    this.canvas = options.canvas
    this.canvasSurface = surface
    this.canvas.addEventListener('contextlost', this.onContextLost)
    this.canvas.addEventListener('contextrestored', this.onContextRestored)
    this.canvasPaintMode = mode
    surface.useMetrics(this.metrics)
    this.reuseMetrics = surface.reuseMetrics
    this.pixelMetrics = surface.reuseMetrics
  }

  override dispose(): void {
    this.canvas.removeEventListener('contextlost', this.onContextLost)
    this.canvas.removeEventListener('contextrestored', this.onContextRestored)
    super.dispose()
  }

  override clearTextureAtlas(): void {
    this.canvasSurface.invalidate()
    this.canvasSurface.refreshFontResources()
    super.clearTextureAtlas()
  }

  override notifySelectionChange(): void {
    this.canvasSurface.invalidate()
    super.notifySelectionChange()
  }

  override refreshRows(startRow: number, endRow: number): void {
    this.canvasSurface.invalidate()
    super.refreshRows(startRow, endRow)
  }

  static async create(options: WebGpuTerminalRendererOptions): Promise<CanvasTerminalRenderer> {
    if (options.rendererMode !== 'canvas2d-pixels') return new CanvasTerminalRenderer(options)
    const [{ ComposeKernel }, { StampTarget }] = await Promise.all([
      import('./kernel.js'),
      import('./stamp-target.js'),
    ])
    const kernel = await ComposeKernel.create()
    return new CanvasTerminalRenderer(options, (_canvas, output) => new StampTarget(kernel, output))
  }
}
