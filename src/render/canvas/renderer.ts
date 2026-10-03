import type { RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import type { CanonicalRendererTheme, CursorState } from '../instances/types.js'
import type {
  RendererGridSize,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from '../renderer.js'
import {
  RowTerminalRenderer,
  type RowRendererMetrics,
  type RowRendererSurface,
} from '../row-renderer.js'
import { CanvasRowPainter, type Canvas2dContext } from './painter.js'
import { canvasScrollPlan, type CanvasScrollPlan } from './scroll.js'

export interface CanvasRendererMetrics extends RowRendererMetrics, CanvasReuseMetrics {}

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
  private image?: PaintedImage
  private capturing = false
  private pending = new Map<number, string>()
  private plan?: CanvasScrollPlan
  private nextImage?: PaintedImage
  private remaining = 0
  private rowHeight = 0
  private rowCount = 0
  reuseMetrics: CanvasReuseMetrics = { copiedRows: 0, repaintedRows: 0, selfCopies: 0 }

  constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    options: WebGpuTerminalRendererOptions,
  ) {
    this.context = requireContext(canvas)
    this.painter = new CanvasRowPainter(
      this.context,
      options.font,
      canonicalRendererTheme(mergeRendererTheme(options.theme)),
    )
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
        const rows = source.readRows(options)
        if (!this.capturing) return rows
        for (const row of rows) {
          if (row.y < 0 || row.y >= this.rowCount) continue
          if (options?.rows && !options.rows.has(row.y)) continue
          this.pending.set(row.y, JSON.stringify(row.cells))
        }
        return rows
      },
    }
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
  }

  invalidate(): void {
    this.image = undefined
    this.nextImage = undefined
    this.plan = undefined
  }

  paint(row: RenderRow, cursor: CursorState | undefined): void {
    try {
      if (!this.plan) this.prepare(cursor)
      if (!this.canReuse(row.y, cursor)) {
        this.painter.paint(row, cursor, this.canvas.width)
        this.reuseMetrics.repaintedRows += 1
      }
      this.remaining -= 1
      if (this.remaining === 0) this.image = this.nextImage
    } catch (cause) {
      // A partial copy/paint no longer corresponds to either complete snapshot.
      this.invalidate()
      throw cause
    }
  }

  resize(font: TerminalFittedFont, grid: RendererGridSize): void {
    this.invalidate()
    this.rowHeight = font.deviceCellHeight
    this.rowCount = grid.rows
    this.canvas.width = grid.columns * font.deviceCellWidth
    this.canvas.height = grid.rows * font.deviceCellHeight
    this.painter.resetContext(font)
    if (!('style' in this.canvas)) return
    this.canvas.style.width = `${grid.columns * font.cssCellWidth}px`
    this.canvas.style.height = `${grid.rows * font.cssCellHeight}px`
  }

  setTheme(theme: CanonicalRendererTheme): void {
    this.invalidate()
    this.painter.setTheme(theme)
  }

  private prepare(cursor: CursorState | undefined): void {
    const previous = this.image?.keys ?? new Map<number, string>()
    const plan = canvasScrollPlan(previous, this.pending, this.rowCount)
    this.plan = Number.isInteger(this.rowHeight) ? plan : { offset: 0, reused: new Set() }
    const keys = new Map(previous)
    for (const [y, key] of this.pending) keys.set(y, key)
    this.nextImage = { keys, cursor: cursor ? { ...cursor } : undefined }
    if (this.plan.offset !== 0) this.copyRows(this.plan.offset)
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
  }
}

export class CanvasTerminalRenderer extends RowTerminalRenderer {
  readonly backend = 'canvas2d' as const
  declare readonly metrics: CanvasRendererMetrics
  readonly reuseMetrics: Readonly<CanvasReuseMetrics>
  private readonly canvasSurface: CanvasSurface

  private constructor(options: WebGpuTerminalRendererOptions) {
    const surface = new CanvasSurface(options.canvas, options)
    super({ ...options, renderState: surface.source(options.renderState) }, surface)
    this.canvasSurface = surface
    surface.reuseMetrics = Object.assign(this.metrics, surface.reuseMetrics)
    this.reuseMetrics = surface.reuseMetrics
  }

  override clearTextureAtlas(): void {
    this.canvasSurface.invalidate()
    super.clearTextureAtlas()
  }

  override notifyScroll(): void {
    this.canvasSurface.invalidate()
    super.notifyScroll()
  }

  override notifySelectionChange(): void {
    this.canvasSurface.invalidate()
    super.notifySelectionChange()
  }

  override refreshRows(startRow: number, endRow: number): void {
    this.canvasSurface.invalidate()
    super.refreshRows(startRow, endRow)
  }

  static create(options: WebGpuTerminalRendererOptions): Promise<CanvasTerminalRenderer> {
    return Promise.resolve(new CanvasTerminalRenderer(options))
  }
}
