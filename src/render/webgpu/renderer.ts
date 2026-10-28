import type { RowBidiMapper } from '../../bidi/row.js'
import { loadBidiMapper, paintedBidiCursor } from '../../bidi/loader.js'
import type {
  RenderStateSource,
  RendererMetrics,
  WebGpuTerminalRendererOptions,
  RendererGridSize,
} from '../shared/types.js'
import { isSoftwareWebGpuAdapter } from './adapter.js'
import { FrameCoordinator } from '../shared/frame-coordinator.js'
import { DeviceOwner, type DeviceLease } from './device-owner.js'
import { createGhosttyError } from '../../core/error.js'
import { captureRenderAcknowledgement } from '../shared/displayed-frame.js'
import { FrameObserver, type PreparedFrame } from '../shared/frame-observer.js'
import { RenderStateDirty } from '../../core/abi.js'
import type { ZigFrameBuilder } from '../../core/zig-frame.js'
import { buildZigFrame } from '../shared/atlas/zig-glyphs.js'
import type { LigatureFinder } from '../shared/ligatures/finder.js'
import { type RenderCursorSnapshot, type RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import type { GlyphAtlas } from '../shared/atlas/atlas.js'
import type { CanvasGlyphRasterizer } from '../shared/atlas/canvas-rasterizer.js'
import type { SharedAtlasSync, SharedGlyphAtlas } from './shared-atlas.js'
import { acquireSharedAtlas, releaseSharedAtlas } from './atlas-registry.js'
import { AtlasGpuTextures } from './gpu-textures.js'
import { renderCursorState, type InactiveCursorStyle, ligatureCursor } from '../shared/cursor.js'
import {
  browserRenderClock,
  canonicalRendererTheme,
  copyFittedFont,
  fittedFontGeometryEquals,
  fittedFontsEqual,
  mergeRendererTheme,
  normalizeRendererGrid,
  safeRendererInteger,
} from '../shared/config.js'
import { type CanonicalRendererTheme, type RendererTheme } from '../shared/instances/types.js'
import { RenderScheduler } from '../shared/scheduler.js'
import { textPassGlyphCapacity, WebGpuTextPass, type TextPassCopy } from './text-pass.js'

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

async function defaultDeviceFactory(adapterPolicy: 'hardware' | 'any'): Promise<GPUDevice> {
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
  if (adapterPolicy === 'hardware' && isSoftwareWebGpuAdapter(adapter)) {
    throw new WebGpuUnavailableError(
      'adapter',
      'Automatic WebGPU selection requires a hardware adapter',
    )
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

const defaultDeviceOwner = new DeviceOwner(() => defaultDeviceFactory('any'))
// Automatic selection cannot borrow an explicit software device.
const hardwareDeviceOwner = new DeviceOwner(() => defaultDeviceFactory('hardware'))
let defaultFrameCoordinator: FrameCoordinator | undefined
function sharedFrameCoordinator(): FrameCoordinator {
  return (defaultFrameCoordinator ??= new FrameCoordinator(browserRenderClock()))
}

export class WebGpuTerminalRenderer {
  private readonly bidi?: RowBidiMapper
  private zigBuilder?: ZigFrameBuilder
  private readonly ligatures?: LigatureFinder
  private sharedAtlas: SharedGlyphAtlas
  private atlasUploadedBytesValue = 0
  private atlasUploadOperationsValue = 0
  private atlasVersion = -1
  private readonly previousAtlasMetrics = { cacheHits: 0, cacheMisses: 0, evictions: 0 }
  private atlasTextures: AtlasGpuTextures
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private readonly context: GPUCanvasContext
  private cursor?: RenderCursorSnapshot
  private readonly textBlinkEnabled: boolean
  private cursorBlinkPreference: boolean
  private cursorPhaseVisible = true
  private textPhaseVisible = true
  private device: GPUDevice
  private focused = false
  private inactiveCursorStyle?: InactiveCursorStyle
  private readonly replacementDeviceOwner: DeviceOwner
  private deviceLease: DeviceLease
  private readonly coordinator?: FrameCoordinator
  private deviceGeneration = 1
  private disposed = false
  private font: TerminalFittedFont
  private format: GPUTextureFormat
  private grid: RendererGridSize
  private frameFailed = false
  private needsFullRebuild = true
  private readonly frames: FrameObserver
  private readonly overlayRows = new Set<number>()
  private readonly onError?: (cause: unknown) => void
  private readonly renderState: RenderStateSource
  private restorePromise?: Promise<void>
  private readonly retiredReleases = new Set<Promise<void>>()
  private deviceUnavailable = false
  private readonly unsubscribeRenderRequest?: () => void
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
  readonly desynchronized = false

  private constructor(
    options: WebGpuTerminalRendererOptions,
    lease: DeviceLease,
    replacementDeviceOwner: DeviceOwner,
    prepared: PreparedRenderer,
    bidi?: RowBidiMapper,
  ) {
    this.canvas = options.canvas
    this.context = prepared.context
    const device = lease.device
    this.device = device
    this.deviceLease = lease
    this.replacementDeviceOwner = replacementDeviceOwner
    if (!options.deviceFactory && !options.schedulerClock)
      this.coordinator = sharedFrameCoordinator()
    this.bidi = bidi
    this.renderState = options.renderState
    this.ligatures = options.ligatures
    this.onError = options.onError
    this.grid = prepared.grid
    this.font = prepared.font
    this.themeInput = mergeRendererTheme(options.theme)
    this.theme = canonicalRendererTheme(this.themeInput)
    this.textBlinkEnabled = options.textBlink ?? false
    this.cursorBlinkPreference = options.cursorBlink ?? false
    this.frames = new FrameObserver(options)
    this.frames.resize(this.grid.rows)
    this.format = prepared.format
    this.resizeCanvas()
    this.sharedAtlas = acquireSharedAtlas(this.font, this, this.canvas)
    let atlasTextures: AtlasGpuTextures | undefined
    let textPass: WebGpuTextPass | undefined
    let scheduler: RenderScheduler | undefined
    try {
      this.configureContext(device)
      atlasTextures = this.sharedAtlas.acquireTextures(device)
      this.atlasTextures = atlasTextures
      textPass = this.createTextPass()
      this.textPass = textPass
      this.textPass.syncAtlas(this.atlasTextures)
      this.atlasVersion = this.sharedAtlas.textureVersion(device)
      scheduler = new RenderScheduler({
        textBlink: options.textBlink,
        clock: options.schedulerClock ?? this.coordinator ?? browserRenderClock(),
        onFrame: () => this.drawFrame(),
      })
      this.scheduler = scheduler
      this.setReducedMotion(options.reducedMotion ?? false)
      this.scheduler.schedule()
      this.watchDeviceLoss(device, this.deviceGeneration)
      this.unsubscribeRenderRequest = this.renderState.subscribeRenderRequest?.(() =>
        this.scheduler.schedule(),
      )
    } catch (cause) {
      scheduler?.dispose()
      textPass?.destroy()
      if (atlasTextures) this.sharedAtlas.releaseTextures(device)
      releaseSharedAtlas(this.sharedAtlas, this)
      throw cause
    }
  }

  private get atlas(): GlyphAtlas {
    return this.sharedAtlas.atlas
  }

  private get rasterizer(): CanvasGlyphRasterizer {
    return this.sharedAtlas.rasterizer
  }

  static async create(options: WebGpuTerminalRendererOptions): Promise<WebGpuTerminalRenderer> {
    const bidi = options.bidi ? await loadBidiMapper() : undefined
    const validated = validateRenderer(options)
    let owner = options.adapterPolicy === 'hardware' ? hardwareDeviceOwner : defaultDeviceOwner
    if (options.deviceFactory) owner = new DeviceOwner(options.deviceFactory)
    const replacementOwner = options.deviceFactory ? owner : defaultDeviceOwner
    const lease = await owner.acquire()
    let prepared: PreparedRenderer | undefined
    try {
      textPassGlyphCapacity(lease.device, validated.grid.columns * validated.grid.rows)
      prepared = prepareRenderer(options, validated)
      return new WebGpuTerminalRenderer(options, lease, replacementOwner, prepared, bidi)
    } catch (cause) {
      try {
        prepared?.context.unconfigure()
      } catch {}
      await lease.release()
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
    if (this.disposed) return
    this.invalidateAll()
  }

  notifySelectionChange(): void {
    this.invalidateAll()
  }

  notifyScroll(): void {
    this.refreshRows(0, this.grid.rows - 1)
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

  setReducedMotion(reduced: boolean): void {
    this.scheduler.textBlink?.setReducedMotion(reduced)
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
    this.coordinator?.flushOwner(this)
    if (this.disposed) return
    this.switchSharedAtlas(next)
    this.font = next
    if (geometryChanged) this.rebuildGeometryResources()
    this.invalidateAll()
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.themeInput = mergeRendererTheme({ ...this.themeInput, ...theme })
    this.theme = canonicalRendererTheme(this.themeInput)
    this.invalidateAll()
  }

  resize(grid: RendererGridSize): void {
    this.coordinator?.flushOwner(this)
    if (this.disposed) return
    const next = normalizeRendererGrid(grid)
    if (this.gridEquals(next)) return
    textPassGlyphCapacity(this.device, next.columns * next.rows)
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
    this.coordinator?.flushOwner(this)
    if (this.atlas.hasEvictions(this)) {
      this.needsFullRebuild = true
      this.scheduler.flush()
    }
    this.syncSharedAtlas()
    const width = this.canvas.width
    const height = this.canvas.height
    const bytesPerRow = alignedBytesPerRow(width)
    const output = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    let mapped = false
    let texture: GPUTexture | undefined
    try {
      texture = this.device.createTexture({
        format: this.format,
        size: [width, height],
        usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const command = this.encodeAtlasFrame(texture.createView(), {
        texture,
        buffer: output,
        bytesPerRow,
        size: [width, height],
      })
      try {
        this.device.queue.submit([command])
        this.sharedAtlas.frameSubmitted(this, this.device)
      } catch (cause) {
        this.sharedAtlas.frameFailed(this, this.device)
        throw cause
      }
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
      texture?.destroy()
    }
  }

  async simulateDeviceLoss(): Promise<void> {
    await this.restoreDevice(this.deviceGeneration)
  }

  dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.coordinator?.flushOwner(this)
      this.deviceGeneration += 1
      this.unsubscribeRenderRequest?.()
      this.scheduler.dispose()
      this.zigBuilder?.dispose()
      this.textPass.destroy()
      this.sharedAtlas.releaseTextures(this.device)
      releaseSharedAtlas(this.sharedAtlas, this)
      this.unconfigureContext()
    }
    return Promise.all([this.deviceLease.release(), this.restorePromise])
      .then(() => Promise.all(this.retiredReleases))
      .then(() => {})
  }

  private configureContext(device: GPUDevice): void {
    this.context.configure({
      alphaMode: 'premultiplied',
      device,
      format: this.format,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  private switchSharedAtlas(font: TerminalFittedFont): void {
    this.coordinator?.flushOwner(this)
    if (this.disposed) return
    const previous = this.sharedAtlas
    const next = acquireSharedAtlas(font, this, this.canvas)
    let textures: AtlasGpuTextures | undefined
    try {
      textures = next.acquireTextures(this.device)
      this.textPass.syncAtlas(textures)
    } catch (cause) {
      if (textures) next.releaseTextures(this.device)
      releaseSharedAtlas(next, this)
      throw cause
    }
    const counts = previous.metrics(this)
    this.previousAtlasMetrics.cacheHits += counts.cacheHits
    this.previousAtlasMetrics.cacheMisses += counts.cacheMisses
    this.previousAtlasMetrics.evictions += counts.evictions
    previous.releaseTextures(this.device)
    releaseSharedAtlas(previous, this)
    this.sharedAtlas = next
    this.atlasTextures = textures
    this.atlasVersion = next.textureVersion(this.device)
    this.zigBuilder?.clearGlyphs()
  }

  private syncSharedAtlas(): SharedAtlasSync {
    const sync = this.sharedAtlas.sync(this.device)
    this.atlasUploadedBytesValue += sync.uploadedBytes
    this.atlasUploadOperationsValue += sync.uploadOperations
    const version = this.sharedAtlas.textureVersion(this.device)
    if (version === this.atlasVersion) return sync
    this.atlasVersion = version
    this.atlasTextures = this.sharedAtlas.textures(this.device)
    this.textPass.syncAtlas(this.atlasTextures)
    return sync
  }

  private createTextPass(device: GPUDevice = this.device): WebGpuTextPass {
    return new WebGpuTextPass({
      textBlink: this.textBlinkEnabled,
      device,
      format: this.format,
      height: this.canvas.height,
      instanceCount: this.grid.columns * this.grid.rows,
      width: this.canvas.width,
    })
  }

  private drawFrame(): void {
    if (this.disposed) return
    if (this.atlas.hasEvictions(this)) this.needsFullRebuild = true
    this.coordinator?.flushOwner(this)
    if (this.disposed) return
    if (this.deviceUnavailable) {
      void this.restoreDevice(this.deviceGeneration).catch(() => {})
      return
    }
    const damage = this.renderState.update()
    if (this.renderState.hasSnapshot === false) return
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
    this.coordinator?.flushPending()
    if (!this.disposed) this.onError?.(cause)
  }

  private retryCoordinatedFrame(cause: unknown): void {
    const retry = !this.frameFailed
    this.reportFrameFailure(cause)
    if (retry && !this.disposed) this.scheduler.schedule()
  }

  private drawZigFrame(damage: RenderStateDirty): void {
    const textBlink = this.scheduler.textBlink
    const phaseChanged = textBlink !== undefined && this.textPhaseVisible !== textBlink.visible
    const phaseOnly =
      !this.needsFullRebuild && damage === RenderStateDirty.False && this.overlayRows.size === 0
    if (!this.renderState.createFrameBuilder)
      throw createGhosttyError('frame_builder', 'The GPU renderer requires a native frame builder')
    if (
      !this.needsFullRebuild &&
      damage === RenderStateDirty.False &&
      this.overlayRows.size === 0 &&
      !phaseChanged
    ) {
      this.coordinator?.flushPending()
      if (!this.disposed) this.frames.notifyCleanUpdate(this.renderState)
      return
    }
    let builder = this.zigBuilder
    if (!builder || builder.columns !== this.grid.columns || builder.rows !== this.grid.rows) {
      this.zigBuilder = undefined
      builder?.dispose()
      builder = this.renderState.createFrameBuilder(this.grid.columns, this.grid.rows)
      if (this.ligatures) builder.setLigatures(this.ligatures)
      if (this.bidi) {
        const mapper = this.bidi
        builder.setBidiProjection(() => mapper.projection(this.renderState.readRows()))
      }
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
      stableRows: this.textPass.drawCount === 2,
      overlayRows: this.overlayRows,
      ligatureCursor: this.ligatures
        ? ligatureCursor(this.cursor, this.focused ? undefined : this.inactiveCursorStyle)
        : undefined,
    }
    const status = phaseOnly
      ? 0
      : buildZigFrame(builder, this.atlas, this.rasterizer, options, this)
    if (status !== 0) {
      throw createGhosttyError(
        'frame_builder',
        `The native frame could not be built after atlas recovery (status ${status})`,
      )
    }
    if (textBlink) {
      textBlink.setNeeded(builder.blinkingRows > 0)
      this.textPhaseVisible = textBlink.visible
    }
    const updates = phaseOnly ? [] : builder.changedRanges()
    const rebuiltRows = phaseOnly ? 0 : builder.rowRebuilds
    const atlasSync = this.syncSharedAtlas()
    const operations = this.textPass.uploadFrame(builder, updates)
    const textPhaseChanged = textBlink ? this.textPass.setTextVisible(this.textPhaseVisible) : false
    if (
      !textPhaseChanged &&
      !options.full &&
      this.overlayRows.size === 0 &&
      !atlasSync.textureChanged &&
      atlasSync.uploadedBytes === 0 &&
      operations === 0 &&
      this.textPass.frameUploadedBytes === 0
    ) {
      this.acceptUnchangedFrame(
        damage,
        updates.map((update) => update.row),
      )
      return
    }

    if (!this.coordinator) {
      try {
        this.submitAtlasFrame(this.context.getCurrentTexture().createView())
      } catch (cause) {
        this.reportFrameFailure(cause)
        if (this.disposed) return
        // Retry once in this turn; an acquired canvas texture presents empty after an abandoned submit.
        this.submitAtlasFrame(this.context.getCurrentTexture().createView())
      }
      let rows: readonly RenderRow[] | undefined
      if (this.frames.requiresFullRows) {
        rows = options.full
          ? this.renderState.readRows({ packed: true })
          : this.rowsToRebuild(damage)
      }
      const frame = this.captureFrame(
        rows,
        updates.map((update) => update.row),
      )
      try {
        if (damage !== RenderStateDirty.False) this.renderState.acknowledge()
        this.recordFrame(rebuiltRows, operations)
        this.metrics.zigFrames += 1
        this.needsFullRebuild = false
        this.frameFailed = false
        this.overlayRows.clear()
        frame?.accept()
      } finally {
        frame?.discard()
      }
      frame?.notify()
      return
    }
    let command: GPUCommandBuffer
    try {
      command = this.encodeAtlasFrame(this.context.getCurrentTexture().createView())
    } catch (cause) {
      this.reportFrameFailure(cause)
      if (this.disposed) return
      command = this.encodeAtlasFrame(this.context.getCurrentTexture().createView())
    }
    let rows: readonly RenderRow[] | undefined
    if (this.frames.requiresFullRows) {
      rows = options.full ? this.renderState.readRows({ packed: true }) : this.rowsToRebuild(damage)
    }
    const textPass = this.textPass
    const frameDevice = this.device
    const frameAtlas = this.sharedAtlas
    let frame: PreparedFrame | undefined
    try {
      frame = this.captureFrame(
        rows,
        updates.map((update) => update.row),
      )
    } catch (cause) {
      frameAtlas.frameFailed(this, frameDevice)
      this.retryCoordinatedFrame(cause)
      return
    }
    const acknowledge =
      this.renderState[captureRenderAcknowledgement]?.() ??
      this.renderState.acknowledge.bind(this.renderState)
    this.coordinator.submit({
      owner: this,
      device: frameDevice,
      command,
      commit: () => {
        frameAtlas.frameSubmitted(this, frameDevice)
        if (this.disposed) {
          frame?.discard()
          return
        }
        try {
          textPass.acceptFrame()
          if (damage !== RenderStateDirty.False) acknowledge()
          this.recordFrame(rebuiltRows, operations)
          this.metrics.zigFrames += 1
          this.needsFullRebuild = false
          this.frameFailed = false
          this.overlayRows.clear()
          frame?.accept()
        } finally {
          frame?.discard()
        }
      },
      notify: () => {
        if (!this.disposed) frame?.notify()
      },
      failed: (cause) => {
        frameAtlas.frameFailed(this, frameDevice)
        frame?.discard()
        this.retryCoordinatedFrame(cause)
      },
    })
  }

  private encodeAtlasFrame(view: GPUTextureView, copy?: TextPassCopy): GPUCommandBuffer {
    this.sharedAtlas.beginFrame(this, this.device)
    try {
      return this.textPass.encode(view, copy)
    } catch (cause) {
      this.sharedAtlas.frameFailed(this, this.device)
      throw cause
    }
  }

  private submitAtlasFrame(view: GPUTextureView): void {
    this.sharedAtlas.beginFrame(this, this.device)
    try {
      this.textPass.submit(view)
      this.sharedAtlas.frameSubmitted(this, this.device)
    } catch (cause) {
      this.sharedAtlas.frameFailed(this, this.device)
      throw cause
    }
  }

  private acceptUnchangedFrame(damage: RenderStateDirty, changed: readonly number[]): void {
    const rows = this.frames.requiresFullRows ? this.rowsToRebuild(damage) : undefined
    const frame = this.captureFrame(rows, changed)
    try {
      if (damage !== RenderStateDirty.False) this.renderState.acknowledge()
      frame?.accept()
    } finally {
      frame?.discard()
    }
    // Settle peer submissions before observers can mutate their native state.
    this.coordinator?.flushPending()
    if (!this.disposed) frame?.notify()
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

  private captureFrame(
    rows: readonly RenderRow[] | undefined,
    changed: readonly number[] = rows?.map((row) => row.y) ?? [],
  ): PreparedFrame | undefined {
    if (!this.cursor) return
    return this.frames.capture(
      this.renderState,
      this.cursor,
      paintedBidiCursor(
        this.bidi,
        this.renderState,
        renderCursorState(
          this.cursor,
          this.cursorPhaseVisible,
          this.focused ? undefined : this.inactiveCursorStyle,
        ),
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
    this.coordinator?.flushOwner(this)
    if (this.disposed) return
    this.zigBuilder?.clearGlyphs()
    this.sharedAtlas.invalidate()
  }

  private rebuildGeometryResources(): void {
    this.coordinator?.flushOwner(this)
    if (this.disposed) return
    this.resizeCanvas()
    this.configureContext(this.device)
    this.replaceTextPass()
    this.frames.resize(this.grid.rows)
  }

  private recordFrame(rebuiltRows: number, instanceUploadOperations: number): void {
    const atlasMetrics = this.sharedAtlas.metrics(this)
    this.metrics.atlasCacheHits = this.previousAtlasMetrics.cacheHits + atlasMetrics.cacheHits
    this.metrics.atlasCacheMisses = this.previousAtlasMetrics.cacheMisses + atlasMetrics.cacheMisses
    this.metrics.atlasEvictions = this.previousAtlasMetrics.evictions + atlasMetrics.evictions
    this.metrics.atlasPages = atlasMetrics.pages
    this.metrics.atlasUploadedBytes = this.atlasUploadedBytesValue
    this.metrics.atlasUploadOperations = this.atlasUploadOperationsValue
    this.metrics.draws += this.textPass.drawCount
    this.metrics.instanceUploadOperations += instanceUploadOperations
    this.metrics.rebuiltRows += rebuiltRows
    this.metrics.submittedFrames += 1
    this.metrics.uploadedBytes += this.textPass.frameUploadedBytes
  }

  private replaceTextPass(): void {
    this.coordinator?.flushOwner(this)
    if (this.disposed) return
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
      await replacement.release()
      return
    }
    let resources: ReplacementResources
    try {
      resources = this.prepareReplacement(replacement.device)
    } catch (cause) {
      await replacement.release()
      this.reportFrameFailure(cause)
      return
    }
    if (this.disposed || expectedGeneration !== this.deviceGeneration) {
      resources.textPass.destroy()
      this.sharedAtlas.releaseTextures(replacement.device)
      this.unconfigureContext()
      await replacement.release()
      return
    }
    const previous = this.deviceLease
    this.textPass.destroy()
    this.sharedAtlas.releaseTextures(this.device)
    this.device = replacement.device
    this.deviceLease = replacement
    this.textPass = resources.textPass
    this.atlasVersion = this.sharedAtlas.textureVersion(replacement.device)
    this.atlasTextures = resources.atlasTextures
    this.deviceGeneration += 1
    this.deviceUnavailable = false
    const release = previous.release()
    this.retiredReleases.add(release)
    const forget = () => this.retiredReleases.delete(release)
    void release.then(forget, forget)
    this.needsFullRebuild = true
    this.metrics.deviceRestores += 1
    this.watchDeviceLoss(replacement.device, this.deviceGeneration)
    this.scheduler.schedule()
  }

  private prepareReplacement(device: GPUDevice): ReplacementResources {
    let textPass: WebGpuTextPass | undefined
    let atlasTextures: AtlasGpuTextures | undefined
    try {
      textPassGlyphCapacity(device, this.grid.columns * this.grid.rows)
      atlasTextures = this.sharedAtlas.acquireTextures(device)
      textPass = this.createTextPass(device)
      textPass.syncAtlas(atlasTextures)
      this.configureContext(device)
      return { atlasTextures, textPass }
    } catch (cause) {
      textPass?.destroy()
      if (atlasTextures) this.sharedAtlas.releaseTextures(device)
      this.unconfigureContext()
      throw cause
    }
  }

  private async requestReplacement(): Promise<DeviceLease | undefined> {
    try {
      this.deviceLease.retire()
      return await this.replacementDeviceOwner.acquire()
    } catch (cause) {
      this.reportFrameFailure(cause)
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
