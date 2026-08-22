import { RenderStateDirty } from '../core/abi.js'
import type { GhosttyRenderState } from '../core/render-state.js'
import type { ReadRowsOptions, RenderRow } from '../core/types.js'
import { GlyphAtlas } from './atlas/atlas.js'
import { CanvasGlyphRasterizer } from './atlas/canvas-rasterizer.js'
import { AtlasGpuTextures } from './atlas/gpu-textures.js'
import type { GlyphBitmap } from './atlas/types.js'
import { InstanceRows } from './instances/rows.js'
import {
  defaultRendererTheme,
  type CursorState,
  type RendererTheme,
  type RowInstanceUpdate,
} from './instances/types.js'
import { RenderScheduler, type RenderFrameState, type RenderSchedulerClock } from './scheduler.js'
import { WebGpuTextPass } from './text-pass.js'

export interface RenderStateSource {
  acknowledge(): number
  readRows(options?: ReadRowsOptions): readonly RenderRow[]
  update(): RenderStateDirty
}

export interface RendererMetrics {
  atlasEvictions: number
  deviceRestores: number
  draws: number
  rebuiltRows: number
  submittedFrames: number
  uploadedBytes: number
}

export interface WebGpuTerminalRendererOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas
  cellHeight: number
  cellWidth: number
  columns: number
  cursor?: CursorState
  cursorBlink?: boolean
  deviceFactory?: () => Promise<GPUDevice>
  fontFamily?: string
  fontSize?: number
  renderState: GhosttyRenderState | RenderStateSource
  rows: number
  schedulerClock?: RenderSchedulerClock
  theme?: Partial<RendererTheme>
}

export interface RendererGridSize {
  cellHeight: number
  cellWidth: number
  columns: number
  rows: number
}

const defaultFontFamily = 'monospace'
const defaultFontSize = 14

function browserClock(): RenderSchedulerClock {
  return {
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    clearTimer: (handle) => window.clearTimeout(handle),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  }
}

async function defaultDeviceFactory(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU requestAdapter returned null')
  return adapter.requestDevice()
}

function requireContext(canvas: HTMLCanvasElement | OffscreenCanvas): GPUCanvasContext {
  const context = canvas.getContext('webgpu')
  if (context) return context
  throw new Error('Unable to create a WebGPU canvas context')
}

function mergedTheme(theme: Partial<RendererTheme> | undefined): RendererTheme {
  return { ...defaultRendererTheme, ...theme }
}

function initialCursor(cursor: CursorState | undefined): CursorState {
  return cursor ?? { style: 'block', visible: true, x: 0, y: 0 }
}

function alignedBytesPerRow(width: number): number {
  return Math.ceil((width * 4) / 256) * 256
}

export class WebGpuTerminalRenderer {
  private atlas = new GlyphAtlas()
  private atlasTextures: AtlasGpuTextures
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private readonly context: GPUCanvasContext
  private cursor: CursorState
  private cursorVisible = true
  private device: GPUDevice
  private readonly deviceFactory: () => Promise<GPUDevice>
  private deviceGeneration = 1
  private disposed = false
  private readonly fontFamily: string
  private readonly fontSize: number
  private format: GPUTextureFormat
  private grid: RendererGridSize
  private instances: InstanceRows
  private needsFullRebuild = true
  private readonly overlayRows = new Set<number>()
  private rasterizer: CanvasGlyphRasterizer
  private readonly renderState: RenderStateSource
  private restoring = false
  private readonly scheduler: RenderScheduler
  private textPass: WebGpuTextPass
  private theme: RendererTheme
  readonly metrics: RendererMetrics = {
    atlasEvictions: 0,
    deviceRestores: 0,
    draws: 0,
    rebuiltRows: 0,
    submittedFrames: 0,
    uploadedBytes: 0,
  }

  private constructor(options: WebGpuTerminalRendererOptions, device: GPUDevice) {
    this.canvas = options.canvas
    this.context = requireContext(options.canvas)
    this.device = device
    this.deviceFactory = options.deviceFactory ?? defaultDeviceFactory
    this.renderState = options.renderState
    this.grid = {
      cellHeight: options.cellHeight,
      cellWidth: options.cellWidth,
      columns: options.columns,
      rows: options.rows,
    }
    this.fontFamily = options.fontFamily ?? defaultFontFamily
    this.fontSize = options.fontSize ?? defaultFontSize
    this.theme = mergedTheme(options.theme)
    this.cursor = initialCursor(options.cursor)
    this.format = navigator.gpu.getPreferredCanvasFormat()
    this.resizeCanvas()
    this.configureContext()
    this.instances = this.createInstances()
    this.rasterizer = this.createRasterizer()
    this.atlasTextures = new AtlasGpuTextures()
    this.textPass = this.createTextPass()
    this.scheduler = new RenderScheduler({
      clock: options.schedulerClock ?? browserClock(),
      onFrame: (state) => this.drawFrame(state),
    })
    this.scheduler.setCursorBlinkEnabled(options.cursorBlink ?? false)
    this.watchDeviceLoss(device, this.deviceGeneration)
    this.scheduler.schedule()
  }

  static async create(options: WebGpuTerminalRendererOptions): Promise<WebGpuTerminalRenderer> {
    const factory = options.deviceFactory ?? defaultDeviceFactory
    const device = await factory()
    return new WebGpuTerminalRenderer(options, device)
  }

  get hasPendingFrame(): boolean {
    return this.scheduler.hasPendingFrame
  }

  get hasPendingTimer(): boolean {
    return this.scheduler.hasPendingTimer
  }

  notifySelectionChange(): void {
    this.invalidateAll()
  }

  notifyScroll(): void {
    this.invalidateAll()
  }

  notifyWrite(): void {
    this.scheduler.schedule()
  }

  schedule(): void {
    this.scheduler.schedule()
  }

  setCursor(cursor: CursorState): void {
    this.overlayRows.add(this.cursor.y)
    this.overlayRows.add(cursor.y)
    this.cursor = cursor
    this.scheduler.schedule()
  }

  setCursorBlinkEnabled(enabled: boolean): void {
    this.scheduler.setCursorBlinkEnabled(enabled)
  }

  setDocumentVisible(visible: boolean): void {
    this.scheduler.setDocumentVisible(visible)
  }

  setFocused(focused: boolean): void {
    this.overlayRows.add(this.cursor.y)
    this.scheduler.setFocused(focused)
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.theme = mergedTheme({ ...this.theme, ...theme })
    this.invalidateAll()
  }

  resize(grid: RendererGridSize): void {
    this.grid = grid
    this.resizeCanvas()
    this.configureContext()
    this.instances = this.createInstances()
    this.rasterizer = this.createRasterizer()
    this.replaceTextPass()
    this.invalidateAll()
  }

  async capturePixels(): Promise<Uint8Array> {
    const width = this.canvas.width
    const height = this.canvas.height
    const bytesPerRow = alignedBytesPerRow(width)
    const output = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = this.device.createCommandEncoder()
    encoder.copyTextureToBuffer(
      { texture: this.context.getCurrentTexture() },
      { buffer: output, bytesPerRow },
      [width, height],
    )
    this.device.queue.submit([encoder.finish()])
    await output.mapAsync(GPUMapMode.READ)
    const mapped = new Uint8Array(output.getMappedRange())
    const pixels = new Uint8Array(width * height * 4)
    for (let row = 0; row < height; row += 1) {
      const source = mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4)
      pixels.set(source, row * width * 4)
    }
    output.unmap()
    output.destroy()
    return pixels
  }

  async simulateDeviceLoss(): Promise<void> {
    await this.restoreDevice(this.deviceGeneration)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.deviceGeneration += 1
    this.scheduler.dispose()
    this.textPass.destroy()
    this.atlasTextures.destroy()
    this.device.destroy()
  }

  private configureContext(): void {
    this.context.configure({
      alphaMode: 'premultiplied',
      device: this.device,
      format: this.format,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  private createInstances(): InstanceRows {
    return new InstanceRows(this.grid)
  }

  private createRasterizer(): CanvasGlyphRasterizer {
    return new CanvasGlyphRasterizer({
      cellHeight: this.grid.cellHeight,
      cellWidth: this.grid.cellWidth,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
    })
  }

  private createTextPass(): WebGpuTextPass {
    return new WebGpuTextPass({
      device: this.device,
      format: this.format,
      height: this.canvas.height,
      instanceCount: this.grid.columns * this.grid.rows,
      width: this.canvas.width,
    })
  }

  private drawFrame(state: RenderFrameState): void {
    if (this.disposed || this.restoring) return
    if (this.cursorVisible !== state.cursorVisible) this.overlayRows.add(this.cursor.y)
    this.cursorVisible = state.cursorVisible
    const damage = this.renderState.update()
    const rows = this.rowsToRebuild(damage)
    if (rows.length === 0) return
    const updates = this.rebuildRows(rows)
    if (updates.some((update) => update.invalidatedRows.length > 0)) {
      this.needsFullRebuild = true
      this.scheduler.schedule()
      return
    }
    this.atlasTextures.sync(this.device, this.atlas.consumeUploads())
    this.textPass.syncAtlas(this.atlasTextures)
    this.textPass.upload(this.instances, updates)
    this.textPass.submit(this.context.getCurrentTexture().createView())
    if (damage !== RenderStateDirty.False) this.renderState.acknowledge()
    this.recordFrame(updates)
    this.needsFullRebuild = false
    this.overlayRows.clear()
  }

  private glyphLookup() {
    return {
      beginRow: (row: number) => this.atlas.beginRow(row),
      resolve: (key: string, bitmap: GlyphBitmap, row: number) =>
        this.atlas.getOrInsert(key, bitmap, row),
    }
  }

  private invalidateAll(): void {
    this.needsFullRebuild = true
    this.scheduler.schedule()
  }

  private rebuildRows(rows: readonly RenderRow[]): readonly RowInstanceUpdate[] {
    const updates: RowInstanceUpdate[] = []
    const cursor = { ...this.cursor, visible: this.cursor.visible && this.cursorVisible }
    for (const row of rows) {
      updates.push(
        this.instances.rebuildRow(row, this.glyphLookup(), this.rasterizer, this.theme, cursor),
      )
    }
    return updates
  }

  private recordFrame(updates: readonly RowInstanceUpdate[]): void {
    this.metrics.atlasEvictions = this.atlas.evictionCount
    this.metrics.draws += 2
    this.metrics.rebuiltRows += updates.length
    this.metrics.submittedFrames += 1
    for (const update of updates) {
      this.metrics.uploadedBytes += update.background.byteLength + update.glyph.byteLength
    }
  }

  private replaceTextPass(): void {
    this.textPass.destroy()
    this.textPass = this.createTextPass()
  }

  private resizeCanvas(): void {
    this.canvas.width = this.grid.columns * this.grid.cellWidth
    this.canvas.height = this.grid.rows * this.grid.cellHeight
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

  private async restoreDevice(expectedGeneration: number): Promise<void> {
    if (this.disposed || this.restoring) return
    if (expectedGeneration !== this.deviceGeneration) return
    this.restoring = true
    const generation = ++this.deviceGeneration
    const previous = this.device
    const replacement = await this.requestReplacement(generation)
    if (!replacement) return
    if (this.disposed || generation !== this.deviceGeneration) {
      replacement.destroy()
      return
    }
    this.textPass.destroy()
    this.atlasTextures.destroy()
    this.atlas.invalidateAll()
    this.device = replacement
    previous.destroy()
    this.atlasTextures = new AtlasGpuTextures()
    this.configureContext()
    this.textPass = this.createTextPass()
    this.needsFullRebuild = true
    this.restoring = false
    this.metrics.deviceRestores += 1
    this.watchDeviceLoss(replacement, generation)
    this.scheduler.schedule()
  }

  private async requestReplacement(generation: number): Promise<GPUDevice | undefined> {
    try {
      return await this.deviceFactory()
    } catch {
      if (!this.disposed && generation === this.deviceGeneration) this.restoring = false
      return undefined
    }
  }

  private watchDeviceLoss(device: GPUDevice, generation: number): void {
    void device.lost.then(() => this.restoreDevice(generation))
  }
}
