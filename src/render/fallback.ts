import type { GpuBackend } from './backend-order.js'
import { DomTerminalRenderer } from './dom/renderer.js'
import type { TerminalFittedFont } from '../term/types.js'
import { CanvasUnavailableError, CanvasTerminalRenderer } from './canvas/renderer.js'
import type { RowRendererMetrics } from './row-renderer.js'
import {
  copyFittedFont,
  mergeRendererTheme,
  normalizeRendererGrid,
  safeRendererInteger,
} from './config.js'
import type { InactiveCursorStyle } from './cursor.js'
import type { RendererTheme } from './instances/types.js'
import { WebGpuTerminalRenderer, WebGpuUnavailableError } from './renderer.js'
import type {
  RendererGridSize,
  RendererMetrics,
  WebGpuTerminalRendererOptions,
} from './renderer.js'
import { WebGlTerminalRenderer } from './webgl/renderer.js'

type ReplacementRenderer = CanvasTerminalRenderer | DomTerminalRenderer | WebGpuTerminalRenderer

type FallbackState =
  | { kind: 'webgl2'; renderer: WebGlTerminalRenderer }
  | { kind: 'switching' | 'failed'; renderer: WebGlTerminalRenderer }
  | { kind: 'canvas2d' | 'dom' | 'webgpu'; renderer: ReplacementRenderer }
  | {
      kind: 'disposed'
      renderer: ReplacementRenderer | WebGlTerminalRenderer
    }

export class FallbackTerminalRenderer {
  private documentVisible = true
  private focused = false
  private inactiveCursorStyle?: InactiveCursorStyle
  private readonly options: WebGpuTerminalRendererOptions
  private state: FallbackState

  private constructor(
    renderer: WebGlTerminalRenderer,
    options: WebGpuTerminalRendererOptions,
    private readonly replaceCanvas: () => HTMLCanvasElement | OffscreenCanvas,
    private readonly signal?: AbortSignal,
    private readonly remainingBackends: readonly GpuBackend[] = [],
  ) {
    this.options = options
    this.state = { kind: 'webgl2', renderer }
    signal?.addEventListener('abort', this.handleAbort, { once: true })
  }

  static async create(
    options: WebGpuTerminalRendererOptions,
    replaceCanvas: () => HTMLCanvasElement | OffscreenCanvas,
    signal?: AbortSignal,
    remainingBackends: readonly GpuBackend[] = [],
  ): Promise<FallbackTerminalRenderer> {
    const prepared = {
      ...options,
      ...normalizeRendererGrid(options),
      font: copyFittedFont(options.font),
      theme: mergeRendererTheme(options.theme),
    }
    let fallback: FallbackTerminalRenderer | undefined
    let contextLost = false
    const renderer = await WebGlTerminalRenderer.create({
      ...prepared,
      onContextLost: () => {
        contextLost = true
        fallback?.switchRenderer()
      },
    })
    fallback = new FallbackTerminalRenderer(
      renderer,
      prepared,
      replaceCanvas,
      signal,
      remainingBackends,
    )
    if (signal?.aborted) fallback.dispose()
    if (contextLost) fallback.switchRenderer()
    return fallback
  }

  get backend(): 'canvas2d' | 'dom' | 'webgl2' | 'webgpu' {
    return this.state.renderer.backend
  }

  get metrics(): RowRendererMetrics | RendererMetrics {
    return this.state.renderer.metrics
  }

  get canPaint(): boolean {
    return this.activeRenderer?.canPaint ?? false
  }

  get hasPendingFrame(): boolean {
    return this.activeRenderer?.hasPendingFrame ?? false
  }

  get hasPendingTimer(): boolean {
    return this.activeRenderer?.hasPendingTimer ?? false
  }

  clearTextureAtlas(): void {
    this.activeRenderer?.clearTextureAtlas()
  }

  notifyScroll(): void {
    this.activeRenderer?.notifyScroll()
  }

  notifySelectionChange(): void {
    this.activeRenderer?.notifySelectionChange()
  }

  notifyWrite(): void {
    this.activeRenderer?.notifyWrite()
  }

  refreshRows(startRow: number, endRow: number): void {
    const start = safeRendererInteger('startRow', startRow)
    const end = safeRendererInteger('endRow', endRow)
    if (start > end) throw new RangeError('startRow must not exceed endRow')
    if (end >= this.options.rows)
      throw new RangeError('endRow must be less than the renderer row count')
    this.activeRenderer?.refreshRows(start, end)
  }

  resize(grid: RendererGridSize): void {
    const next = normalizeRendererGrid(grid)
    this.activeRenderer?.resize(next)
    this.options.columns = next.columns
    this.options.rows = next.rows
  }

  schedule(): void {
    this.activeRenderer?.schedule()
  }

  setCursorBlinkEnabled(enabled: boolean): void {
    this.options.cursorBlink = enabled
    this.activeRenderer?.setCursorBlinkEnabled(enabled)
  }

  setDocumentVisible(visible: boolean): void {
    this.documentVisible = visible
    this.activeRenderer?.setDocumentVisible(visible)
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    this.activeRenderer?.setFocused(focused)
  }

  setInactiveCursorStyle(style: InactiveCursorStyle | undefined): void {
    this.inactiveCursorStyle = style
    this.activeRenderer?.setInactiveCursorStyle(style)
  }

  setFont(font: TerminalFittedFont): void {
    const next = copyFittedFont(font)
    this.activeRenderer?.setFont(next)
    this.options.font = next
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.activeRenderer?.setTheme(theme)
    this.options.theme = { ...this.options.theme, ...theme }
  }

  dispose(): void | Promise<void> {
    if (this.state.kind === 'disposed') return
    const renderer = this.state.renderer
    this.state = { kind: 'disposed', renderer }
    this.signal?.removeEventListener('abort', this.handleAbort)
    return renderer.dispose()
  }

  private get activeRenderer(): ReplacementRenderer | WebGlTerminalRenderer | undefined {
    if (
      this.state.kind === 'webgl2' ||
      this.state.kind === 'canvas2d' ||
      this.state.kind === 'dom' ||
      this.state.kind === 'webgpu'
    )
      return this.state.renderer
    return undefined
  }

  private readonly handleAbort = (): void => {
    void this.dispose()
  }

  private switchRenderer(): void {
    if (this.state.kind !== 'webgl2') return
    const renderer = this.state.renderer
    this.state = { kind: 'switching', renderer }
    renderer.dispose()
    void this.createReplacement().catch((cause: unknown) => {
      if (this.state.kind === 'disposed') return
      this.state = { kind: 'failed', renderer }
      this.options.onError?.(cause)
    })
  }

  private async createReplacement(): Promise<void> {
    this.signal?.throwIfAborted()
    const canvas = this.replaceCanvas()
    if (this.state.kind === 'disposed') return
    this.options.canvas = canvas
    const renderer = await this.createReplacementRenderer(canvas)
    if (!renderer) return
    if (this.state.kind !== 'switching') {
      renderer.dispose()
      return
    }
    try {
      this.applySettings(renderer)
    } catch (cause) {
      renderer.dispose()
      throw cause
    }
    this.state = { kind: renderer.backend, renderer }
  }

  private async createReplacementRenderer(
    canvas: HTMLCanvasElement | OffscreenCanvas,
  ): Promise<ReplacementRenderer | undefined> {
    for (const backend of this.remainingBackends) {
      if (backend !== 'webgpu') continue
      this.signal?.throwIfAborted()
      if (this.state.kind === 'disposed') return
      try {
        return await WebGpuTerminalRenderer.create({
          ...this.options,
          canvas,
          adapterPolicy: 'hardware',
        })
      } catch (cause) {
        if (!(cause instanceof WebGpuUnavailableError)) throw cause
      }
    }
    this.signal?.throwIfAborted()
    if (this.state.kind === 'disposed') return
    try {
      return await CanvasTerminalRenderer.create({ ...this.options, canvas })
    } catch (cause) {
      if (!(cause instanceof CanvasUnavailableError)) throw cause
    }
    this.signal?.throwIfAborted()
    return DomTerminalRenderer.create({ ...this.options, canvas })
  }

  private applySettings(renderer: ReplacementRenderer): void {
    renderer.setDocumentVisible(false)
    renderer.setFont(this.options.font)
    renderer.resize(this.options)
    renderer.setTheme(this.options.theme ?? {})
    renderer.setCursorBlinkEnabled(this.options.cursorBlink ?? false)
    renderer.setFocused(this.focused)
    renderer.setInactiveCursorStyle(this.inactiveCursorStyle)
    renderer.setDocumentVisible(this.documentVisible)
  }
}
