import { createGhosttyError } from '../core/error.js'
import { FrameObserver } from './frame-observer.js'
import { RenderStateDirty } from '../core/abi.js'
import type { ZigFrameBuilder } from '../core/zig-frame.js'
import { buildZigFrame } from './atlas/zig-glyphs.js'
import type { GhosttyRenderState } from '../core/render-state.js'
import {
  type CellStyle,
  type RgbColor,
  type RenderCell,
  type ReadRowsOptions,
  type RenderCursorSnapshot,
  type RenderRow,
} from '../core/types.js'
import type { TerminalFittedFont } from '../term/types.js'
import { GlyphAtlas } from './atlas/atlas.js'
import { CanvasGlyphRasterizer } from './atlas/canvas-rasterizer.js'
import { AtlasGpuTextures } from './atlas/gpu-textures.js'
import { renderCursorState, type InactiveCursorStyle } from './cursor.js'
import {
  browserRenderClock,
  canonicalRendererTheme,
  copyFittedFont,
  fittedFontGeometryEquals,
  fittedFontsEqual,
  mergeRendererTheme,
  normalizeRendererGrid,
  safeRendererInteger,
} from './config.js'
import {
  type CanonicalRendererTheme,
  type CursorState,
  type RendererTheme,
  type RowInstanceUpdate,
} from './instances/types.js'
import { RenderScheduler, type RenderSchedulerClock } from './scheduler.js'
import { WebGpuTextPass } from './text-pass.js'

export interface RenderStateSource {
  readonly snapshotVersion?: number
  createFrameBuilder?(columns: number, rows: number): ZigFrameBuilder
  acknowledge(): number
  readCursor(): RenderCursorSnapshot
  readRows(options?: ReadRowsOptions): readonly RenderRow[]
  readTextRows?(options?: ReadRowsOptions): readonly RendererTextFrameRow[]
  update(): RenderStateDirty
}

export type RendererFrameCell = Readonly<
  Omit<RenderCell, 'background' | 'foreground' | 'style'>
> & {
  readonly background?: Readonly<RgbColor>
  readonly foreground?: Readonly<RgbColor>
  readonly style?: Readonly<CellStyle>
}

export interface RendererFrameRow extends RendererTextFrameRow {
  readonly renderCells: readonly RendererFrameCell[]
}

export interface RendererTextFrameRow {
  readonly cells: readonly string[]
  readonly continuations: readonly boolean[]
  readonly text: string
  readonly y: number
}

export interface RendererFrameSnapshot extends RendererTextFrameSnapshot {
  readonly rows: readonly RendererFrameRow[]
}

export interface RendererTextFrameSnapshot {
  readonly paintedCursor?: Readonly<CursorState>
  readonly cursor: Readonly<RenderCursorSnapshot>
  readonly rows: readonly RendererTextFrameRow[]
}

export interface RendererMetrics {
  zigFrames: number
  atlasCacheHits: number
  atlasCacheMisses: number
  atlasEvictions: number
  atlasPages: number
  atlasUploadedBytes: number
  atlasUploadOperations: number
  deviceRestores: number
  draws: number
  instanceUploadOperations: number
  rebuiltRows: number
  submittedFrames: number
  uploadedBytes: number
}

export interface WebGpuTerminalRendererOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas
  columns: number
  cursorBlink?: boolean
  deviceFactory?: () => Promise<GPUDevice>
  font: TerminalFittedFont
  onError?: (cause: unknown) => void
  /** Called after a clean render-state update needs no painting or row notification. */
  onCleanUpdate?: () => void
  onFrame?: (snapshot: RendererFrameSnapshot) => void
  /** Owned row text with lazily decoded cell strings and continuation flags. */
  onTextFrame?: (snapshot: RendererTextFrameSnapshot) => void
  /** Return false for cursor-only snapshots; row data resumes with the full viewport. */
  needsFrameRows?: () => boolean
  /** Painted row IDs without requesting cell data. */
  onRowsChanged?: (rows: readonly number[]) => void
  onRowsPainted?: (rows: readonly RenderRow[]) => void
  replaceCanvas?: () => HTMLCanvasElement | OffscreenCanvas
  renderState: GhosttyRenderState | RenderStateSource
  rows: number
  schedulerClock?: RenderSchedulerClock
  theme?: Partial<RendererTheme>
}

export interface RendererGridSize {
  columns: number
  rows: number
}

interface PreparedRenderer {
  readonly context: GPUCanvasContext
  readonly font: TerminalFittedFont
  readonly format: GPUTextureFormat
  readonly grid: RendererGridSize
}

interface ValidatedRenderer {
  readonly font: TerminalFittedFont
  readonly grid: RendererGridSize
}

interface ReplacementResources {
  readonly atlasTextures: AtlasGpuTextures
  readonly textPass: WebGpuTextPass
}

export type WebGpuUnavailableReason = 'adapter' | 'api' | 'context'

export class WebGpuUnavailableError extends Error {
  readonly reason: WebGpuUnavailableReason

  constructor(reason: WebGpuUnavailableReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebGpuUnavailableError'
    this.reason = reason
  }
}

async function defaultDeviceFactory(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new WebGpuUnavailableError('api', 'WebGPU is unavailable')
  let adapter: GPUAdapter | null
  try {
    adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    })
  } catch (cause) {
    throw new WebGpuUnavailableError('adapter', 'WebGPU adapter request failed', { cause })
  }
  if (!adapter) {
    throw new WebGpuUnavailableError('adapter', 'WebGPU requestAdapter returned null')
  }
  try {
    return await adapter.requestDevice()
  } catch (cause) {
    throw new WebGpuUnavailableError('adapter', 'WebGPU device request failed', { cause })
  }
}

function requireContext(canvas: HTMLCanvasElement | OffscreenCanvas): GPUCanvasContext {
  const context = canvas.getContext('webgpu')
  if (context) return context
  throw new WebGpuUnavailableError('context', 'Unable to create a WebGPU canvas context')
}

function alignedBytesPerRow(width: number): number {
  return Math.ceil((width * 4) / 256) * 256
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

function validateRenderer(options: WebGpuTerminalRendererOptions): ValidatedRenderer {
  return {
    font: copyFittedFont(options.font),
    grid: normalizeRendererGrid({
      columns: options.columns,
      rows: options.rows,
    }),
  }
}

function prepareRenderer(
  options: WebGpuTerminalRendererOptions,
  validated: ValidatedRenderer,
): PreparedRenderer {
  if (!navigator.gpu) throw new WebGpuUnavailableError('api', 'WebGPU is unavailable')
  const format = navigator.gpu.getPreferredCanvasFormat()
  return { ...validated, context: requireContext(options.canvas), format }
}

function releaseFailedDevice(context: GPUCanvasContext, device: GPUDevice): void {
  try {
    context.unconfigure()
  } catch {}
  device.destroy()
}

async function destroyDeviceAfterSubmittedWork(device: GPUDevice): Promise<void> {
  try {
    await device.queue.onSubmittedWorkDone()
  } catch {}
  device.destroy()
}

export class WebGpuTerminalRenderer {
  private zigBuilder?: ZigFrameBuilder
  private atlas = new GlyphAtlas()
  private atlasUploadedBytesOffset = 0
  private atlasUploadOperationsOffset = 0
  private atlasTextures: AtlasGpuTextures
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private readonly context: GPUCanvasContext
  private cursor?: RenderCursorSnapshot
  private cursorBlinkPreference: boolean
  private cursorPhaseVisible = true
  private device: GPUDevice
  private focused = false
  private inactiveCursorStyle?: InactiveCursorStyle
  private readonly deviceFactory: () => Promise<GPUDevice>
  private deviceGeneration = 1
  private disposed = false
  private font: TerminalFittedFont
  private format: GPUTextureFormat
  private grid: RendererGridSize
  private frameFailed = false
  private needsFullRebuild = true
  private readonly frames: FrameObserver
  private readonly overlayRows = new Set<number>()
  private rasterizer: CanvasGlyphRasterizer
  private readonly onError?: (cause: unknown) => void
  private readonly renderState: RenderStateSource
  private restorePromise?: Promise<void>
  private deviceUnavailable = false
  private readonly scheduler: RenderScheduler
  private textPass: WebGpuTextPass
  private theme: CanonicalRendererTheme
  private themeInput: RendererTheme
  readonly metrics: RendererMetrics = {
    zigFrames: 0,
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
  readonly backend = 'webgpu' as const

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
    this.onError = options.onError
    this.grid = prepared.grid
    this.font = prepared.font
    this.themeInput = mergeRendererTheme(options.theme)
    this.theme = canonicalRendererTheme(this.themeInput)
    this.cursorBlinkPreference = options.cursorBlink ?? false
    this.frames = new FrameObserver(options)
    this.frames.resize(this.grid.rows)
    this.format = prepared.format
    this.resizeCanvas()
    this.configureContext(device)
    this.rasterizer = this.createRasterizer()
    this.atlasTextures = new AtlasGpuTextures(device, this.atlas.textureLayout)
    this.textPass = this.createTextPass()
    this.textPass.syncAtlas(this.atlasTextures)
    this.scheduler = new RenderScheduler({
      clock: options.schedulerClock ?? browserRenderClock(),
      onFrame: () => this.drawFrame(),
    })
    this.watchDeviceLoss(device, this.deviceGeneration)
    this.scheduler.schedule()
  }

  static async create(options: WebGpuTerminalRendererOptions): Promise<WebGpuTerminalRenderer> {
    const validated = validateRenderer(options)
    const factory = options.deviceFactory ?? defaultDeviceFactory
    const device = await factory()
    let prepared: PreparedRenderer | undefined
    try {
      prepared = prepareRenderer(options, validated)
      return new WebGpuTerminalRenderer(options, device, prepared)
    } catch (cause) {
      if (prepared) releaseFailedDevice(prepared.context, device)
      if (!prepared) device.destroy()
      throw cause
    }
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
    this.resetAtlasResources()
    this.invalidateAll()
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

  refreshRows(startRow: number, endRow: number): void {
    const start = safeRendererInteger('startRow', startRow)
    const end = safeRendererInteger('endRow', endRow)
    if (start > end) throw new RangeError('startRow must not exceed endRow')
    if (end >= this.grid.rows)
      throw new RangeError('endRow must be less than the renderer row count')
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
    const geometryChanged = !fittedFontGeometryEquals(this.font, next)
    this.font = next
    if (geometryChanged) this.rebuildGeometryResources()
    this.rasterizer = this.createRasterizer()
    this.resetAtlasResources()
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
    for (const row of this.overlayRows) {
      if (row >= next.rows) this.overlayRows.delete(row)
    }
    this.grid = next
    this.resizeCanvas()
    this.replaceTextPass()
    this.frames.resize(this.grid.rows)
    this.repaintNow()
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
    this.zigBuilder?.dispose()
    this.textPass.destroy()
    this.atlasTextures.destroy()
    this.unconfigureContext()
    // Retaining the device through its fence prevents the observed locked final-queue release.
    void destroyDeviceAfterSubmittedWork(this.device)
  }

  private configureContext(device: GPUDevice): void {
    this.context.configure({
      alphaMode: 'premultiplied',
      device,
      format: this.format,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  private createRasterizer(): CanvasGlyphRasterizer {
    return new CanvasGlyphRasterizer({ font: this.font })
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
    try {
      this.drawZigFrame(damage)
    } catch (cause) {
      this.reportFrameFailure(cause)
    }
  }

  private reportFrameFailure(cause: unknown): void {
    this.needsFullRebuild = true
    if (this.frameFailed) return
    this.frameFailed = true
    this.onError?.(cause)
  }

  private drawZigFrame(damage: RenderStateDirty): void {
    if (!this.renderState.createFrameBuilder)
      throw createGhosttyError('frame_builder', 'The GPU renderer requires a native frame builder')
    if (
      !this.needsFullRebuild &&
      damage === RenderStateDirty.False &&
      this.overlayRows.size === 0
    ) {
      this.frames.notifyCleanUpdate()
      return
    }
    let builder = this.zigBuilder
    if (!builder || builder.columns !== this.grid.columns || builder.rows !== this.grid.rows) {
      this.zigBuilder = undefined
      builder?.dispose()
      builder = this.renderState.createFrameBuilder(this.grid.columns, this.grid.rows)
      this.zigBuilder = builder
      this.needsFullRebuild = true
    }
    const options = {
      cellWidth: this.deviceCellWidth,
      cellHeight: this.deviceCellHeight,
      theme: this.theme,
      cursor: renderCursorState(
        this.cursor,
        this.cursorPhaseVisible,
        this.focused ? undefined : this.inactiveCursorStyle,
      ),
      full: this.needsFullRebuild,
      overlayRows: this.overlayRows,
    }
    const status = buildZigFrame(builder, this.atlas, this.rasterizer, options)
    if (status !== 0) {
      throw createGhosttyError(
        'frame_builder',
        `The native frame could not be built after atlas recovery (status ${status})`,
      )
    }
    const updates = builder.changedRanges()
    this.atlasTextures.sync(this.atlas.consumeUploads())
    const operations = this.textPass.uploadFrame(builder, updates)
    try {
      this.textPass.submit(this.context.getCurrentTexture().createView())
    } catch (cause) {
      this.reportFrameFailure(cause)
      // Retry once in this turn; an acquired canvas texture presents empty after an abandoned submit.
      this.textPass.submit(this.context.getCurrentTexture().createView())
    }
    let rows: readonly RenderRow[] | undefined
    if (this.frames.requiresFullRows) {
      rows = options.full ? this.renderState.readRows({ packed: true }) : this.rowsToRebuild(damage)
    }
    if (damage !== RenderStateDirty.False) this.renderState.acknowledge()
    this.recordFrame(updates, operations)
    this.metrics.zigFrames += 1
    this.needsFullRebuild = false
    this.frameFailed = false
    this.overlayRows.clear()
    this.emitFrame(
      rows,
      updates.map((update) => update.row),
    )
  }

  private get deviceCellHeight(): number {
    return this.font.deviceCellHeight
  }

  private get deviceCellWidth(): number {
    return this.font.deviceCellWidth
  }

  private addCursorRow(cursor: RenderCursorSnapshot | undefined): void {
    if (!cursor?.visible) return
    const row = cursor?.viewport?.y
    if (row === undefined) return
    if (row < 0 || row >= this.grid.rows) return
    this.overlayRows.add(row)
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

  private resetCursorBlink(): void {
    this.scheduler.setCursorBlinkEnabled(false)
    this.synchronizeCursorBlink()
  }

  // Assigning the canvas size wiped the backbuffer; a scheduled frame would
  // present it empty once before repainting.
  private repaintNow(): void {
    this.needsFullRebuild = true
    this.scheduler.flush()
  }

  private resetAtlasResources(): void {
    this.zigBuilder?.clearGlyphs()
    this.atlas.invalidateAll()
  }

  private rebuildGeometryResources(): void {
    this.resizeCanvas()
    this.configureContext(this.device)
    this.replaceTextPass()
    this.frames.resize(this.grid.rows)
  }

  private recordFrame(
    updates: readonly RowInstanceUpdate[],
    instanceUploadOperations: number,
  ): void {
    this.metrics.atlasCacheHits = this.atlas.cacheHitCount
    this.metrics.atlasCacheMisses = this.atlas.cacheMissCount
    this.metrics.atlasEvictions = this.atlas.evictionCount
    this.metrics.atlasPages = this.atlas.pageCount
    this.metrics.atlasUploadedBytes = this.atlasUploadedBytesOffset + this.atlasTextures.uploadBytes
    this.metrics.atlasUploadOperations =
      this.atlasUploadOperationsOffset + this.atlasTextures.uploadOperationCount
    this.metrics.draws += 2
    this.metrics.instanceUploadOperations += instanceUploadOperations
    this.metrics.rebuiltRows += updates.length
    this.metrics.submittedFrames += 1
    for (const update of updates) {
      this.metrics.uploadedBytes += update.cell.byteLength + update.glyph.byteLength
    }
  }

  private replaceTextPass(): void {
    const replacement = this.createTextPass()
    replacement.syncAtlas(this.atlasTextures)
    this.textPass.destroy()
    this.textPass = replacement
  }

  private resizeCanvas(): void {
    const logicalWidth = this.grid.columns * this.font.cssCellWidth
    const logicalHeight = this.grid.rows * this.font.cssCellHeight
    this.canvas.width = this.grid.columns * this.deviceCellWidth
    this.canvas.height = this.grid.rows * this.deviceCellHeight
    if (!('style' in this.canvas)) return
    this.canvas.style.width = `${logicalWidth}px`
    this.canvas.style.height = `${logicalHeight}px`
  }

  private rowsToRebuild(damage: RenderStateDirty): readonly RenderRow[] {
    if (this.needsFullRebuild) return this.renderState.readRows({ packed: true })
    const rows = new Map<number, RenderRow>()
    if (damage !== RenderStateDirty.False) {
      for (const row of this.renderState.readRows({
        packed: true,
        dirtyOnly: true,
      }))
        rows.set(row.y, row)
    }
    if (this.overlayRows.size === 0) return [...rows.values()]
    const missingRows = new Set<number>()
    for (const row of this.overlayRows) {
      if (!rows.has(row)) missingRows.add(row)
    }
    if (missingRows.size === 0) return [...rows.values()]
    for (const row of this.renderState.readRows({
      packed: true,
      rows: missingRows,
    })) {
      if (missingRows.has(row.y)) rows.set(row.y, row)
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
    const resources = this.prepareReplacement(replacement)
    if (!resources) return
    if (this.disposed || expectedGeneration !== this.deviceGeneration) {
      resources.textPass.destroy()
      resources.atlasTextures.destroy()
      releaseFailedDevice(this.context, replacement)
      return
    }
    const previous = this.device
    this.atlasUploadedBytesOffset += this.atlasTextures.uploadBytes
    this.atlasUploadOperationsOffset += this.atlasTextures.uploadOperationCount
    this.textPass.destroy()
    this.atlasTextures.destroy()
    this.atlas.markAllForUpload()
    this.device = replacement
    this.textPass = resources.textPass
    this.atlasTextures = resources.atlasTextures
    this.deviceGeneration += 1
    this.deviceUnavailable = false
    previous.destroy()
    this.needsFullRebuild = true
    this.metrics.deviceRestores += 1
    this.watchDeviceLoss(replacement, this.deviceGeneration)
    this.scheduler.schedule()
  }

  private prepareReplacement(device: GPUDevice): ReplacementResources | undefined {
    let textPass: WebGpuTextPass | undefined
    let atlasTextures: AtlasGpuTextures | undefined
    try {
      atlasTextures = new AtlasGpuTextures(device, this.atlas.textureLayout)
      textPass = this.createTextPass(device)
      textPass.syncAtlas(atlasTextures)
      this.configureContext(device)
      return { atlasTextures, textPass }
    } catch {
      textPass?.destroy()
      atlasTextures?.destroy()
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
