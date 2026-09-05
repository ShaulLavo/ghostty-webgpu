import type { TerminalFittedFont } from '../term/types.js'
import { CanvasTerminalRenderer, type CanvasRendererMetrics } from './canvas/renderer.js'
import {
  copyFittedFont,
  mergeRendererTheme,
  normalizeRendererGrid,
  safeRendererInteger,
} from './config.js'
import type { InactiveCursorStyle } from './cursor.js'
import type { RendererTheme } from './instances/types.js'
import type {
  RendererGridSize,
  RendererMetrics,
  WebGpuTerminalRendererOptions,
} from './renderer.js'
import { WebGlTerminalRenderer } from './webgl/renderer.js'

type FallbackState =
  | { kind: 'webgl2'; renderer: WebGlTerminalRenderer }
  | { kind: 'switching' | 'failed'; renderer: WebGlTerminalRenderer }
  | { kind: 'canvas2d'; renderer: CanvasTerminalRenderer }
  | { kind: 'disposed'; renderer: CanvasTerminalRenderer | WebGlTerminalRenderer }

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
  ) {
    this.options = options
    this.state = { kind: 'webgl2', renderer }
    signal?.addEventListener('abort', this.handleAbort, { once: true })
  }

  static async create(
    options: WebGpuTerminalRendererOptions,
    replaceCanvas: () => HTMLCanvasElement | OffscreenCanvas,
    signal?: AbortSignal,
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
        fallback?.switchToCanvas()
      },
    })
    fallback = new FallbackTerminalRenderer(renderer, prepared, replaceCanvas, signal)
    if (signal?.aborted) fallback.dispose()
    if (contextLost) fallback.switchToCanvas()
    return fallback
  }

  get backend(): 'canvas2d' | 'webgl2' {
    return this.state.renderer.backend
  }

  get metrics(): CanvasRendererMetrics | RendererMetrics {
    return this.state.renderer.metrics
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

  dispose(): void {
    if (this.state.kind === 'disposed') return
    const renderer = this.state.renderer
    this.state = { kind: 'disposed', renderer }
    this.signal?.removeEventListener('abort', this.handleAbort)
    renderer.dispose()
  }

  private get activeRenderer(): CanvasTerminalRenderer | WebGlTerminalRenderer | undefined {
    if (this.state.kind === 'webgl2' || this.state.kind === 'canvas2d') return this.state.renderer
    return undefined
  }

  private readonly handleAbort = (): void => this.dispose()

  private switchToCanvas(): void {
    if (this.state.kind !== 'webgl2') return
    const renderer = this.state.renderer
    this.state = { kind: 'switching', renderer }
    renderer.dispose()
    void this.createCanvasReplacement().catch((cause: unknown) => {
      if (this.state.kind === 'disposed') return
      this.state = { kind: 'failed', renderer }
      this.options.onError?.(cause)
    })
  }

  private async createCanvasReplacement(): Promise<void> {
    this.signal?.throwIfAborted()
    const canvas = this.replaceCanvas()
    if (this.state.kind === 'disposed') return
    this.options.canvas = canvas
    const renderer = await CanvasTerminalRenderer.create({ ...this.options, canvas })
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
    this.state = { kind: 'canvas2d', renderer }
  }

  private applySettings(renderer: CanvasTerminalRenderer): void {
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
