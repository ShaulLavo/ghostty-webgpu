import type { TerminalFittedFont } from '../../term/types.js'
import type { CanvasTerminalRenderer } from '../canvas/renderer.js'
import type { FallbackTerminalRenderer } from './fallback.js'
import type { WebGlTerminalRenderer } from '../webgl/renderer.js'
import type { WebGpuTerminalRenderer } from '../webgpu/renderer.js'
import { copyFittedFont, normalizeRendererGrid } from './config.js'
import type { InactiveCursorStyle } from './cursor.js'
import {
  attachCanvasImage,
  type CanvasImagePublisher,
  type DisplayedFrameOptions,
  type StartupCanvas,
} from './displayed-frame.js'
import type { RendererTheme } from './instances/types.js'
import { captureBlinkPhase, seedBlinkPhase } from './scheduler.js'
import type { RendererGridSize, WebGpuTerminalRendererOptions } from './types.js'

type RendererOptions = WebGpuTerminalRendererOptions & DisplayedFrameOptions
type GpuRenderer = WebGlTerminalRenderer | WebGpuTerminalRenderer | FallbackTerminalRenderer
type RendererState =
  | { kind: 'canvas'; renderer: CanvasTerminalRenderer }
  | { kind: 'ready'; renderer: CanvasTerminalRenderer; gpu: GpuRenderer }
  | { kind: 'painting'; renderer: GpuRenderer; previous: CanvasTerminalRenderer }
  | { kind: 'gpu'; renderer: GpuRenderer }
  | { kind: 'disposed' }

interface StartupRendererOptions {
  canvas: HTMLCanvasElement
  createGpu(options: RendererOptions): Promise<GpuRenderer | undefined>
  host: StartupCanvas
  options: RendererOptions
  signal: AbortSignal
}

export class StartupTerminalRenderer {
  private state: RendererState
  private pendingFrame?: number
  private started = false
  private documentVisible = true
  private focused = false
  private inactiveCursorStyle?: InactiveCursorStyle
  private readonly options: Omit<RendererOptions, 'canvas'>
  private readonly host: StartupCanvas
  private readonly signal: AbortSignal
  private readonly createGpu: StartupRendererOptions['createGpu']

  private constructor(
    renderer: CanvasTerminalRenderer,
    config: StartupRendererOptions,
    private readonly view: Window,
  ) {
    this.host = config.host
    this.signal = config.signal
    this.createGpu = config.createGpu
    this.state = { kind: 'canvas', renderer }
    const { canvas: _canvas, ...options } = config.options
    this.options = {
      ...options,
      ...normalizeRendererGrid(options),
      font: copyFittedFont(options.font),
    }
  }

  static async create(
    config: StartupRendererOptions,
  ): Promise<StartupTerminalRenderer | undefined> {
    const view = config.canvas.ownerDocument.defaultView
    if (!view) return
    const { options, signal } = config
    let startup: StartupTerminalRenderer | undefined
    let renderer: CanvasTerminalRenderer
    try {
      const { CanvasTerminalRenderer } = await import('../canvas/renderer.js')
      signal.throwIfAborted()
      renderer = await CanvasTerminalRenderer.create({
        ...options,
        rendererMode: 'canvas2d-pixels',
        onRowsChanged: (rows) => {
          options.onRowsChanged?.(rows)
          startup?.afterCanvasFrame()
        },
      })
    } catch {
      signal.throwIfAborted()
      if (options.replaceCanvas) options.canvas = options.replaceCanvas()
      return
    }
    startup = new StartupTerminalRenderer(renderer, config, view)
    if (!signal.aborted) return startup
    startup.dispose()
    signal.throwIfAborted()
  }

  private get active() {
    return this.state.kind === 'disposed' ? undefined : this.state.renderer
  }

  get backend() {
    return this.active?.backend
  }

  get canPaint(): boolean {
    return this.active?.canPaint ?? false
  }

  get desynchronized(): boolean {
    return this.active?.desynchronized ?? false
  }

  get hasPendingFrame(): boolean {
    return this.active?.hasPendingFrame ?? false
  }

  get hasPendingTimer(): boolean {
    return this.active?.hasPendingTimer ?? false
  }

  clearTextureAtlas(): void {
    this.active?.clearTextureAtlas()
  }

  notifyScroll(): void {
    this.active?.notifyScroll()
  }

  notifySelectionChange(): void {
    this.active?.notifySelectionChange()
  }

  notifyWrite(): void {
    this.active?.notifyWrite()
  }

  paintPending(): boolean {
    const renderer = this.active
    return Boolean(renderer && 'paintPending' in renderer && renderer.paintPending())
  }

  refreshRows(startRow: number, endRow: number): void {
    this.active?.refreshRows(startRow, endRow)
  }

  resize(grid: RendererGridSize): void {
    const next = normalizeRendererGrid(grid)
    this.active?.resize(next)
    this.options.columns = next.columns
    this.options.rows = next.rows
  }

  schedule(): void {
    this.active?.schedule()
  }

  setCursorBlinkEnabled(enabled: boolean): void {
    this.options.cursorBlink = enabled
    this.active?.setCursorBlinkEnabled(enabled)
  }

  setDocumentVisible(visible: boolean): void {
    this.documentVisible = visible
    this.active?.setDocumentVisible(visible)
    if (visible && this.state.kind === 'ready') this.scheduleHandoff()
  }

  setReducedMotion(reduced: boolean): void {
    this.options.reducedMotion = reduced
    this.active?.setReducedMotion(reduced)
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    this.active?.setFocused(focused)
  }

  setInactiveCursorStyle(style: InactiveCursorStyle | undefined): void {
    this.inactiveCursorStyle = style
    this.active?.setInactiveCursorStyle(style)
  }

  setFont(font: TerminalFittedFont): void {
    const next = copyFittedFont(font)
    this.active?.setFont(next)
    this.options.font = next
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.active?.setTheme(theme)
    this.options.theme = { ...this.options.theme, ...theme }
  }

  dispose(): void {
    const state = this.state
    if (state.kind === 'disposed') return
    this.state = { kind: 'disposed' }
    if (this.pendingFrame !== undefined) this.view.cancelAnimationFrame(this.pendingFrame)
    if (state.kind === 'ready') state.gpu.dispose()
    if (state.kind === 'painting') state.previous.dispose()
    state.renderer.dispose()
  }

  private afterCanvasFrame(): void {
    if (this.started || this.state.kind !== 'canvas') return
    this.started = true
    // The current frame must reach the compositor before getContext can block the page.
    this.requestFrame(() => void this.startGpu())
  }

  private requestFrame(callback: () => void): void {
    if (this.pendingFrame !== undefined) return
    this.pendingFrame = this.view.requestAnimationFrame(() => {
      this.pendingFrame = undefined
      callback()
    })
  }

  private async startGpu(): Promise<void> {
    const { signal } = this
    const makeCanvas = () => this.view.document.createElement('canvas')
    let canvas: HTMLCanvasElement | undefined = makeCanvas()
    try {
      const gpu = await this.createGpu({
        ...this.options,
        canvas,
        replaceCanvas: () => {
          signal.throwIfAborted()
          if (this.state.kind === 'gpu' && this.options.replaceCanvas)
            return this.options.replaceCanvas()
          canvas = makeCanvas()
          return canvas
        },
        [attachCanvasImage]: () =>
          this.attachGpuImage(() => {
            const painted = canvas
            canvas = undefined
            return painted
          }),
        onError: this.handleGpuError,
      })
      if (!gpu) return
      if (this.state.kind !== 'canvas' || signal.aborted) {
        gpu.dispose()
        return
      }
      gpu.setDocumentVisible(false)
      this.state = { kind: 'ready', renderer: this.state.renderer, gpu }
      this.scheduleHandoff()
    } catch (cause) {
      this.handleGpuError(cause)
    }
  }

  private scheduleHandoff(): void {
    if (!this.documentVisible) return
    this.requestFrame(() => this.paintGpu())
  }

  private paintGpu(): void {
    const state = this.state
    if (state.kind !== 'ready' || !this.documentVisible) return
    if (!this.host.canAdopt() || this.options.renderState.renderHeld) {
      this.scheduleHandoff()
      return
    }
    const { renderer: previous, gpu } = state
    previous.setDocumentVisible(false)
    this.state = { kind: 'painting', renderer: gpu, previous }
    try {
      this.applySettings(gpu)
      gpu[seedBlinkPhase](previous[captureBlinkPhase]())
      gpu.paintPending()
    } catch (cause) {
      this.handleGpuError(cause)
    }
    this.keepCanvasIfUnpainted()
  }

  private attachGpuImage(takeCanvas: () => HTMLCanvasElement | undefined): CanvasImagePublisher {
    let publisher: CanvasImagePublisher | undefined
    return {
      notify: (isCurrent: () => boolean) => {
        const state = this.state
        if (state.kind === 'painting') {
          const canvas = takeCanvas()
          if (!canvas) return
          this.host.adopt(canvas)
          this.state = { kind: 'gpu', renderer: state.renderer }
          state.previous.dispose()
        }
        if (this.state.kind !== 'gpu') return
        publisher ??= this.options[attachCanvasImage]?.()
        publisher?.notify(isCurrent)
      },
      dispose: () => publisher?.dispose(),
    }
  }

  private readonly handleGpuError = (cause: unknown): void => {
    if (this.state.kind === 'disposed' || this.signal.aborted) return
    this.options.onError?.(cause)
  }

  private keepCanvasIfUnpainted(): void {
    const state = this.state
    if (state.kind !== 'painting') return
    this.state = { kind: 'canvas', renderer: state.previous }
    state.renderer.dispose()
    state.previous.setDocumentVisible(this.documentVisible)
    state.previous[seedBlinkPhase](state.previous[captureBlinkPhase]())
    state.previous.refreshRows(0, this.options.rows - 1)
  }

  private applySettings(renderer: GpuRenderer): void {
    renderer.setFont(this.options.font)
    renderer.resize(this.options)
    renderer.setTheme(this.options.theme ?? {})
    renderer.setCursorBlinkEnabled(this.options.cursorBlink ?? false)
    renderer.setReducedMotion(this.options.reducedMotion ?? false)
    renderer.setFocused(this.focused)
    renderer.setInactiveCursorStyle(this.inactiveCursorStyle)
    renderer.setDocumentVisible(this.documentVisible)
  }
}
