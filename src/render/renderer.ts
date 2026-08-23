import { RenderStateDirty } from '../core/abi.js'
import type { GhosttyRenderState } from '../core/render-state.js'
import {
  normalizeCellGeometry,
  type NormalizedCellGeometry,
  type ReadRowsOptions,
  type RenderCursorSnapshot,
  type RenderRow,
} from '../core/types.js'
import { GlyphAtlas } from './atlas/atlas.js'
import { CanvasGlyphRasterizer } from './atlas/canvas-rasterizer.js'
import { AtlasGpuTextures } from './atlas/gpu-textures.js'
import { renderCursorState } from './cursor.js'
import type { GlyphBitmap } from './atlas/types.js'
import { InstanceRows } from './instances/rows.js'
import {
  defaultRendererTheme,
  type RendererTheme,
  type RowInstanceUpdate,
} from './instances/types.js'
import { RenderScheduler, type RenderSchedulerClock } from './scheduler.js'
import { WebGpuTextPass } from './text-pass.js'

export interface RenderStateSource {
  acknowledge(): number
  readCursor(): RenderCursorSnapshot
  readRows(options?: ReadRowsOptions): readonly RenderRow[]
  update(): RenderStateDirty
}

export interface RendererFrameRow {
  readonly cells: readonly string[]
  readonly continuations: readonly boolean[]
  readonly text: string
  readonly y: number
}

export interface RendererFrameSnapshot {
  readonly cursor: Readonly<RenderCursorSnapshot>
  readonly rows: readonly RendererFrameRow[]
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
  cursorBlink?: boolean
  deviceFactory?: () => Promise<GPUDevice>
  fontFamily?: string
  fontSize?: number
  onFrame?: (snapshot: RendererFrameSnapshot) => void
  pixelRatio?: number
  renderState: GhosttyRenderState | RenderStateSource
  rows: number
  schedulerClock?: RenderSchedulerClock
  theme?: Partial<RendererTheme>
}

export interface RendererGridSize {
  cellHeight: number
  cellWidth: number
  columns: number
  pixelRatio: number
  rows: number
}

interface PreparedRenderer {
  readonly context: GPUCanvasContext
  readonly fontFamily: string
  readonly fontSize: number
  readonly format: GPUTextureFormat
  readonly grid: NormalizedRendererGrid
}

type NormalizedRendererGrid = RendererGridSize & NormalizedCellGeometry

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

function alignedBytesPerRow(width: number): number {
  return Math.ceil((width * 4) / 256) * 256
}

function positiveFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be finite and greater than zero`)
}

function positiveInteger(name: string, value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new RangeError(`${name} must be a positive safe integer`)
}

function nonEmptyString(name: string, value: string): string {
  if (typeof value === 'string' && value.length > 0) return value.slice()
  throw new TypeError(`${name} must be a non-empty string`)
}

function normalizeGrid(grid: RendererGridSize): NormalizedRendererGrid {
  const geometry = normalizeCellGeometry(grid)
  return {
    ...geometry,
    columns: positiveInteger('columns', grid.columns),
    rows: positiveInteger('rows', grid.rows),
  }
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

function prepareRenderer(options: WebGpuTerminalRendererOptions): PreparedRenderer {
  return {
    context: requireContext(options.canvas),
    fontFamily: nonEmptyString('fontFamily', options.fontFamily ?? defaultFontFamily),
    fontSize: positiveFinite('fontSize', options.fontSize ?? defaultFontSize),
    format: navigator.gpu.getPreferredCanvasFormat(),
    grid: normalizeGrid({
      cellHeight: options.cellHeight,
      cellWidth: options.cellWidth,
      columns: options.columns,
      pixelRatio: options.pixelRatio ?? 1,
      rows: options.rows,
    }),
  }
}

function releaseFailedDevice(context: GPUCanvasContext, device: GPUDevice): void {
  try {
    context.unconfigure()
  } catch {}
  device.destroy()
}

export class WebGpuTerminalRenderer {
  private atlas = new GlyphAtlas()
  private atlasTextures: AtlasGpuTextures
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private readonly context: GPUCanvasContext
  private cursor?: RenderCursorSnapshot
  private cursorBlinkPreference: boolean
  private cursorPhaseVisible = true
  private device: GPUDevice
  private readonly deviceFactory: () => Promise<GPUDevice>
  private deviceGeneration = 1
  private disposed = false
  private fontFamily: string
  private fontSize: number
  private format: GPUTextureFormat
  private grid: NormalizedRendererGrid
  private instances: InstanceRows
  private needsFullRebuild = true
  private readonly onFrame?: (snapshot: RendererFrameSnapshot) => void
  private readonly overlayRows = new Set<number>()
  private rasterizer: CanvasGlyphRasterizer
  private readonly renderState: RenderStateSource
  private restorePromise?: Promise<void>
  private deviceUnavailable = false
  private readonly scheduler: RenderScheduler
  private textPass: WebGpuTextPass
  private theme: RendererTheme
  private visibleRows: (RendererFrameRow | undefined)[]
  readonly metrics: RendererMetrics = {
    atlasEvictions: 0,
    deviceRestores: 0,
    draws: 0,
    rebuiltRows: 0,
    submittedFrames: 0,
    uploadedBytes: 0,
  }

  private constructor(
    options: WebGpuTerminalRendererOptions,
    device: GPUDevice,
    prepared: PreparedRenderer,
  ) {
    this.canvas = options.canvas
    this.context = prepared.context
    this.device = device
    this.deviceFactory = options.deviceFactory ?? defaultDeviceFactory
    this.renderState = options.renderState
    this.grid = prepared.grid
    this.fontFamily = prepared.fontFamily
    this.fontSize = prepared.fontSize
    this.theme = mergedTheme(options.theme)
    this.cursorBlinkPreference = options.cursorBlink ?? false
    this.onFrame = options.onFrame
    this.visibleRows = Array.from({ length: this.grid.rows })
    this.format = prepared.format
    this.resizeCanvas()
    this.configureContext(device)
    this.instances = this.createInstances()
    this.rasterizer = this.createRasterizer()
    this.atlasTextures = new AtlasGpuTextures()
    this.textPass = this.createTextPass()
    this.scheduler = new RenderScheduler({
      clock: options.schedulerClock ?? browserClock(),
      onFrame: () => this.drawFrame(),
    })
    this.watchDeviceLoss(device, this.deviceGeneration)
    this.scheduler.schedule()
  }

  static async create(options: WebGpuTerminalRendererOptions): Promise<WebGpuTerminalRenderer> {
    const prepared = prepareRenderer(options)
    const factory = options.deviceFactory ?? defaultDeviceFactory
    const device = await factory()
    try {
      return new WebGpuTerminalRenderer(options, device, prepared)
    } catch (cause) {
      releaseFailedDevice(prepared.context, device)
      throw cause
    }
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
    this.resetCursorBlink()
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
    this.addCursorRow(this.cursor)
    this.scheduler.setFocused(focused)
  }

  setFont(fontFamily: string, fontSize: number): void {
    const nextFamily = nonEmptyString('fontFamily', fontFamily)
    const nextSize = positiveFinite('fontSize', fontSize)
    if (this.fontFamily === nextFamily && this.fontSize === nextSize) return
    this.fontFamily = nextFamily
    this.fontSize = nextSize
    this.rasterizer = this.createRasterizer()
    this.resetAtlasResources()
    this.invalidateAll()
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.theme = mergedTheme({ ...this.theme, ...theme })
    this.invalidateAll()
  }

  resize(grid: RendererGridSize): void {
    const next = normalizeGrid(grid)
    if (this.gridEquals(next)) return
    this.grid = next
    this.resizeCanvas()
    this.configureContext(this.device)
    this.instances = this.createInstances()
    this.rasterizer = this.createRasterizer()
    this.resetAtlasResources()
    this.replaceTextPass()
    this.visibleRows = Array.from({ length: this.grid.rows })
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
    let mapped = false
    try {
      const encoder = this.device.createCommandEncoder()
      encoder.copyTextureToBuffer(
        { texture: this.context.getCurrentTexture() },
        { buffer: output, bytesPerRow },
        [width, height],
      )
      this.device.queue.submit([encoder.finish()])
      await output.mapAsync(GPUMapMode.READ)
      mapped = true
      const sourcePixels = new Uint8Array(output.getMappedRange())
      const pixels = new Uint8Array(width * height * 4)
      for (let row = 0; row < height; row += 1) {
        const start = row * bytesPerRow
        const source = sourcePixels.subarray(start, start + width * 4)
        pixels.set(source, row * width * 4)
      }
      return pixels
    } finally {
      if (mapped) output.unmap()
      output.destroy()
    }
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
    this.unconfigureContext()
    this.device.destroy()
  }

  private configureContext(device: GPUDevice): void {
    this.context.configure({
      alphaMode: 'premultiplied',
      device,
      format: this.format,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  private createInstances(): InstanceRows {
    return new InstanceRows({
      cellHeight: this.deviceCellHeight,
      cellWidth: this.deviceCellWidth,
      columns: this.grid.columns,
      rows: this.grid.rows,
    })
  }

  private createRasterizer(): CanvasGlyphRasterizer {
    return new CanvasGlyphRasterizer({
      cellHeight: this.deviceCellHeight,
      cellWidth: this.deviceCellWidth,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize * this.grid.pixelRatio,
    })
  }

  private createTextPass(device: GPUDevice = this.device): WebGpuTextPass {
    return new WebGpuTextPass({
      device,
      format: this.format,
      height: this.canvas.height,
      instanceCount: this.grid.columns * this.grid.rows,
      width: this.canvas.width,
    })
  }

  private drawFrame(): void {
    if (this.disposed) return
    if (this.deviceUnavailable) {
      void this.restoreDevice(this.deviceGeneration).catch(() => {})
      return
    }
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
      this.needsFullRebuild = true
      this.scheduler.schedule()
      return
    }
    this.atlasTextures.sync(this.device, this.atlas.consumeUploads())
    this.textPass.syncAtlas(this.atlasTextures)
    this.textPass.upload(this.instances, updates)
    this.textPass.submit(this.context.getCurrentTexture().createView())
    if (damage !== RenderStateDirty.False) this.renderState.acknowledge()
    for (const row of rows) this.visibleRows[row.y] = copiedFrameRow(row)
    this.recordFrame(updates)
    this.needsFullRebuild = false
    this.overlayRows.clear()
    this.emitFrame()
  }

  private glyphLookup() {
    return {
      beginRow: (row: number) => this.atlas.beginRow(row),
      resolve: (key: string, bitmap: GlyphBitmap, row: number) =>
        this.atlas.getOrInsert(key, bitmap, row),
    }
  }

  private get deviceCellHeight(): number {
    return this.grid.deviceCellHeight
  }

  private get deviceCellWidth(): number {
    return this.grid.deviceCellWidth
  }

  private addCursorRow(cursor: RenderCursorSnapshot | undefined): void {
    const row = cursor?.viewport?.y
    if (row === undefined) return
    if (row < 0 || row >= this.grid.rows) return
    this.overlayRows.add(row)
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
    return (
      this.grid.cellHeight === grid.cellHeight &&
      this.grid.cellWidth === grid.cellWidth &&
      this.grid.columns === grid.columns &&
      this.grid.pixelRatio === grid.pixelRatio &&
      this.grid.rows === grid.rows
    )
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
    if (previous && cursorEquals(previous, cursor)) return
    this.addCursorRow(previous)
    this.addCursorRow(cursor)
    this.cursor = cursor
  }

  private invalidateAll(): void {
    this.needsFullRebuild = true
    this.scheduler.schedule()
  }

  private rebuildRows(rows: readonly RenderRow[]): readonly RowInstanceUpdate[] {
    const updates: RowInstanceUpdate[] = []
    const cursor = renderCursorState(this.cursor, this.cursorPhaseVisible)
    for (const row of rows) {
      updates.push(
        this.instances.rebuildRow(row, this.glyphLookup(), this.rasterizer, this.theme, cursor),
      )
    }
    return updates
  }

  private resetCursorBlink(): void {
    this.scheduler.setCursorBlinkEnabled(false)
    this.synchronizeCursorBlink()
  }

  private resetAtlasResources(): void {
    this.atlas.invalidateAll()
    this.atlasTextures.destroy()
    this.atlasTextures = new AtlasGpuTextures()
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
    const replacement = this.createTextPass()
    this.textPass.destroy()
    this.textPass = replacement
  }

  private resizeCanvas(): void {
    const logicalWidth = this.grid.columns * this.grid.cellWidth
    const logicalHeight = this.grid.rows * this.grid.cellHeight
    this.canvas.width = this.grid.columns * this.deviceCellWidth
    this.canvas.height = this.grid.rows * this.deviceCellHeight
    if (!('style' in this.canvas)) return
    this.canvas.style.width = `${logicalWidth}px`
    this.canvas.style.height = `${logicalHeight}px`
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

  private restoreDevice(expectedGeneration: number): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (expectedGeneration !== this.deviceGeneration) return Promise.resolve()
    if (this.restorePromise) return this.restorePromise
    this.deviceUnavailable = true
    const attempt = this.performDeviceRestore(expectedGeneration)
    this.restorePromise = attempt
    void attempt.then(
      () => this.clearRestorePromise(attempt),
      () => this.clearRestorePromise(attempt),
    )
    return attempt
  }

  private async performDeviceRestore(expectedGeneration: number): Promise<void> {
    const replacement = await this.requestReplacement()
    if (!replacement) return
    if (this.disposed || expectedGeneration !== this.deviceGeneration) {
      replacement.destroy()
      return
    }
    const replacementPass = this.prepareReplacement(replacement)
    if (!replacementPass) return
    if (this.disposed || expectedGeneration !== this.deviceGeneration) {
      replacementPass.destroy()
      releaseFailedDevice(this.context, replacement)
      return
    }
    const previous = this.device
    this.textPass.destroy()
    this.atlasTextures.destroy()
    this.atlas.invalidateAll()
    this.device = replacement
    this.textPass = replacementPass
    this.atlasTextures = new AtlasGpuTextures()
    this.deviceGeneration += 1
    this.deviceUnavailable = false
    previous.destroy()
    this.needsFullRebuild = true
    this.metrics.deviceRestores += 1
    this.watchDeviceLoss(replacement, this.deviceGeneration)
    this.scheduler.schedule()
  }

  private prepareReplacement(device: GPUDevice): WebGpuTextPass | undefined {
    let textPass: WebGpuTextPass | undefined
    try {
      textPass = this.createTextPass(device)
      this.configureContext(device)
      return textPass
    } catch {
      textPass?.destroy()
      releaseFailedDevice(this.context, device)
      return undefined
    }
  }

  private async requestReplacement(): Promise<GPUDevice | undefined> {
    try {
      return await this.deviceFactory()
    } catch {
      return undefined
    }
  }

  private clearRestorePromise(attempt: Promise<void>): void {
    if (this.restorePromise !== attempt) return
    this.restorePromise = undefined
  }

  private unconfigureContext(): void {
    try {
      this.context.unconfigure()
    } catch {}
  }

  private watchDeviceLoss(device: GPUDevice, generation: number): void {
    void device.lost.then(
      () => {
        void this.restoreDevice(generation).catch(() => {})
      },
      () => {},
    )
  }
}
