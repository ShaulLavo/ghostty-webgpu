import { normalizeCellGeometry } from '../core/types.js'
import {
  normalizeTerminalElementPadding,
  type TerminalElementPadding,
  type TerminalElementPaddingInput,
} from './elements.js'

export interface TerminalFitFont {
  readonly family: string
  readonly lineHeight: number
  readonly size: number
}

export interface TerminalFitGrid {
  readonly cellHeight: number
  readonly cellWidth: number
  readonly columns: number
  readonly pixelRatio: number
  readonly rows: number
}

export interface TerminalFitResult {
  readonly grid: TerminalFitGrid
  readonly padding: TerminalElementPadding
  readonly scrollbarWidth: number
}

export interface TerminalFitResizeObserver {
  disconnect(): void
  observe(target: Element): void
}

export interface TerminalFitEnvironment {
  cancelFrame(handle: number): void
  createResizeObserver(callback: () => void): TerminalFitResizeObserver
  getPixelRatio(): number
  requestFrame(callback: FrameRequestCallback): number
  subscribePixelRatio(callback: () => void): () => void
}

export interface TerminalFitControllerOptions {
  readonly container: HTMLElement
  readonly environment?: Partial<TerminalFitEnvironment>
  readonly font: TerminalFitFont
  readonly getScrollbarWidth?: () => number
  readonly onFit: (result: TerminalFitResult) => void
  readonly padding?: TerminalElementPaddingInput
  readonly paddingElement: HTMLElement
  readonly signal?: AbortSignal
}

interface ElementSize {
  readonly height: number
  readonly width: number
}

function positiveFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be a finite positive number`)
}

function nonEmptyString(name: string, value: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.slice()
  throw new TypeError(`${name} must be a non-empty string`)
}

function normalizeFont(font: TerminalFitFont): TerminalFitFont {
  return Object.freeze({
    family: nonEmptyString('font.family', font.family),
    lineHeight: positiveFinite('font.lineHeight', font.lineHeight),
    size: positiveFinite('font.size', font.size),
  })
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return 0
}

function computedPadding(view: Window, element: HTMLElement): TerminalElementPadding {
  const style = view.getComputedStyle(element)
  return normalizeTerminalElementPadding({
    bottom: cssPixels(style.paddingBottom),
    left: cssPixels(style.paddingLeft),
    right: cssPixels(style.paddingRight),
    top: cssPixels(style.paddingTop),
  })
}

function contentBoxSize(view: Window, element: HTMLElement): ElementSize | undefined {
  if (!Number.isFinite(element.clientWidth) || !Number.isFinite(element.clientHeight)) {
    return undefined
  }
  const style = view.getComputedStyle(element)
  const horizontalInsets = cssPixels(style.paddingLeft) + cssPixels(style.paddingRight)
  const verticalInsets = cssPixels(style.paddingBottom) + cssPixels(style.paddingTop)
  const width = Math.max(0, element.clientWidth - horizontalInsets)
  const height = Math.max(0, element.clientHeight - verticalInsets)
  if (width === 0 || height === 0) return undefined
  return { height, width }
}

function canonicalPixelRatio(value: number): number {
  return positiveFinite('pixelRatio', value)
}

function canonicalCssLength(name: string, value: number, pixelRatio: number): number {
  const devicePixels = Math.round(value * pixelRatio)
  if (Number.isSafeInteger(devicePixels) && devicePixels >= 0) {
    return devicePixels / pixelRatio
  }
  throw new RangeError(`${name} must map to a non-negative safe device-pixel value`)
}

function canonicalPadding(
  padding: TerminalElementPadding,
  pixelRatio: number,
): TerminalElementPadding {
  return Object.freeze({
    bottom: canonicalCssLength('padding.bottom', padding.bottom, pixelRatio),
    left: canonicalCssLength('padding.left', padding.left, pixelRatio),
    right: canonicalCssLength('padding.right', padding.right, pixelRatio),
    top: canonicalCssLength('padding.top', padding.top, pixelRatio),
  })
}

function canonicalScrollbarWidth(value: number, pixelRatio: number): number {
  if (value === 0) return 0
  const positive = positiveFinite('scrollbar width', value)
  const canonical = canonicalCssLength('scrollbar width', positive, pixelRatio)
  if (canonical > 0) return canonical
  return 1 / pixelRatio
}

function fontEquals(left: TerminalFitFont, right: TerminalFitFont): boolean {
  return (
    left.family === right.family && left.lineHeight === right.lineHeight && left.size === right.size
  )
}

function paddingEquals(left: TerminalElementPadding, right: TerminalElementPadding): boolean {
  return (
    left.bottom === right.bottom &&
    left.left === right.left &&
    left.right === right.right &&
    left.top === right.top
  )
}

function gridEquals(left: TerminalFitGrid, right: TerminalFitGrid): boolean {
  return (
    left.cellHeight === right.cellHeight &&
    left.cellWidth === right.cellWidth &&
    left.columns === right.columns &&
    left.pixelRatio === right.pixelRatio &&
    left.rows === right.rows
  )
}

function fitResultEquals(left: TerminalFitResult, right: TerminalFitResult): boolean {
  if (!gridEquals(left.grid, right.grid)) return false
  if (!paddingEquals(left.padding, right.padding)) return false
  return left.scrollbarWidth === right.scrollbarWidth
}

export class TerminalFitController {
  private readonly cancelFrame: (handle: number) => void
  private readonly createResizeObserver: (callback: () => void) => TerminalFitResizeObserver
  private desiredPadding: TerminalElementPadding
  private disposePixelRatioSubscription?: () => void
  private disposed = false
  private readonly document: Document
  private readonly externalSignal?: AbortSignal
  private font: TerminalFitFont
  private frameHandle?: number
  private readonly getPixelRatio: () => number
  private lastResult?: TerminalFitResult
  private readonly lifecycle = new AbortController()
  private readonly measureContext: CanvasRenderingContext2D
  private pixelRatioQuery?: MediaQueryList
  private readonly requestFrame: (callback: FrameRequestCallback) => number
  private resizeObserver?: TerminalFitResizeObserver
  private watchedPixelRatio: number
  private readonly view: Window

  private constructor(private readonly options: TerminalFitControllerOptions) {
    this.document = options.container.ownerDocument
    const view = this.document.defaultView
    if (!view) throw new TypeError('container must belong to a document with a window')
    this.view = view
    const environment = options.environment
    const injectedCancelFrame = environment?.cancelFrame
    const injectedObserverFactory = environment?.createResizeObserver
    const injectedPixelRatio = environment?.getPixelRatio
    const injectedRequestFrame = environment?.requestFrame
    this.cancelFrame = injectedCancelFrame
      ? (handle) => injectedCancelFrame.call(environment, handle)
      : (handle) => view.cancelAnimationFrame(handle)
    this.createResizeObserver = injectedObserverFactory
      ? (callback) => injectedObserverFactory.call(environment, callback)
      : createBrowserResizeObserver
    this.getPixelRatio = injectedPixelRatio
      ? () => injectedPixelRatio.call(environment)
      : () => view.devicePixelRatio
    this.requestFrame = injectedRequestFrame
      ? (callback) => injectedRequestFrame.call(environment, callback)
      : (callback) => view.requestAnimationFrame(callback)
    this.font = normalizeFont(options.font)
    this.desiredPadding =
      options.padding === undefined
        ? computedPadding(view, options.paddingElement)
        : normalizeTerminalElementPadding(options.padding)
    const context = this.document.createElement('canvas').getContext('2d')
    if (!context) throw new TypeError('Unable to create a canvas text measurement context')
    this.measureContext = context
    this.watchedPixelRatio = this.readPixelRatio()
    this.externalSignal = options.signal
  }

  static create(options: TerminalFitControllerOptions): TerminalFitController {
    const controller = new TerminalFitController(options)
    try {
      controller.start()
      return controller
    } catch (cause) {
      controller.dispose()
      throw cause
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameHandle !== undefined) this.cancelFrame(this.frameHandle)
    this.frameHandle = undefined
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    this.unbindPixelRatioQuery()
    this.externalSignal?.removeEventListener('abort', this.handleExternalAbort)
    this.lifecycle.abort()
    this.disposePixelRatioSubscription?.()
    this.disposePixelRatioSubscription = undefined
  }

  get hasPendingFrame(): boolean {
    return this.frameHandle !== undefined
  }

  requestFit(): void {
    if (this.disposed || this.frameHandle !== undefined) return
    this.frameHandle = this.requestFrame(this.runFit)
  }

  setFont(font: TerminalFitFont): void {
    if (this.disposed) return
    const next = normalizeFont(font)
    if (fontEquals(this.font, next)) return
    this.font = next
    this.lastResult = undefined
    this.trackFontLoad()
    this.requestFit()
  }

  setPadding(padding: TerminalElementPaddingInput): void {
    if (this.disposed) return
    const next = normalizeTerminalElementPadding(padding)
    if (paddingEquals(this.desiredPadding, next)) return
    this.desiredPadding = next
    this.requestFit()
  }

  private bindPixelRatioQuery(): void {
    this.unbindPixelRatioQuery()
    this.watchedPixelRatio = this.readPixelRatio()
    if (typeof this.view.matchMedia !== 'function') return
    const query = this.view.matchMedia(`(resolution: ${this.watchedPixelRatio}dppx)`)
    query.addEventListener('change', this.handlePixelRatioChange)
    this.pixelRatioQuery = query
  }

  private calculateFit(): TerminalFitResult | undefined {
    const size = contentBoxSize(this.view, this.options.container)
    if (!size) return undefined
    const pixelRatio = this.readPixelRatio()
    const padding = canonicalPadding(this.desiredPadding, pixelRatio)
    const scrollbarWidth = canonicalScrollbarWidth(
      this.options.getScrollbarWidth?.() ?? 0,
      pixelRatio,
    )
    const availableWidth = size.width - padding.left - padding.right - scrollbarWidth
    const availableHeight = size.height - padding.bottom - padding.top
    if (availableWidth <= 0 || availableHeight <= 0) return undefined
    const geometry = normalizeCellGeometry({
      cellHeight: this.font.size * this.font.lineHeight,
      cellWidth: this.measureCellWidth(),
      pixelRatio,
    })
    const grid: TerminalFitGrid = Object.freeze({
      cellHeight: geometry.cellHeight,
      cellWidth: geometry.cellWidth,
      columns: Math.max(2, Math.floor(availableWidth / geometry.cellWidth)),
      pixelRatio,
      rows: Math.max(1, Math.floor(availableHeight / geometry.cellHeight)),
    })
    return Object.freeze({ grid, padding, scrollbarWidth })
  }

  private readonly handleExternalAbort = (): void => {
    this.dispose()
  }

  private readonly handleFontEvent = (): void => {
    this.requestFit()
  }

  private readonly handlePixelRatioChange = (): void => {
    if (this.disposed) return
    if (!this.options.environment?.subscribePixelRatio) this.bindPixelRatioQuery()
    this.requestFit()
  }

  private readonly handleResize = (): void => {
    this.requestFit()
  }

  private readonly handleWindowResize = (): void => {
    const pixelRatio = this.readPixelRatio()
    if (pixelRatio !== this.watchedPixelRatio) this.bindPixelRatioQuery()
    this.requestFit()
  }

  private measureCellWidth(): number {
    this.measureContext.font = `${this.font.size}px ${this.font.family}`
    return positiveFinite('measured cell width', this.measureContext.measureText('M').width)
  }

  private readonly runFit = (): void => {
    this.frameHandle = undefined
    if (this.disposed) return
    const result = this.calculateFit()
    if (!result) return
    if (this.lastResult && fitResultEquals(this.lastResult, result)) return
    this.options.onFit(result)
    this.lastResult = result
  }

  private start(): void {
    this.externalSignal?.throwIfAborted()
    this.externalSignal?.addEventListener('abort', this.handleExternalAbort, { once: true })
    const observer = this.createResizeObserver(this.handleResize)
    this.resizeObserver = observer
    observer.observe(this.options.container)
    const signal = this.lifecycle.signal
    this.startPixelRatioSubscription(signal)
    this.document.fonts.addEventListener('loadingdone', this.handleFontEvent, { signal })
    this.document.fonts.addEventListener('loadingerror', this.handleFontEvent, { signal })
    this.trackFontLoad()
    void this.document.fonts.ready.then(this.handleFontEvent, this.handleFontEvent)
    this.requestFit()
  }

  private trackFontLoad(): void {
    const descriptor = `${this.font.size}px ${this.font.family}`
    let loading: Promise<FontFace[]>
    try {
      loading = this.document.fonts.load(descriptor, 'M')
    } catch {
      return
    }
    void loading.then(this.handleFontEvent, this.handleFontEvent)
  }

  private readPixelRatio(): number {
    return canonicalPixelRatio(this.getPixelRatio())
  }

  private startPixelRatioSubscription(signal: AbortSignal): void {
    const subscribe = this.options.environment?.subscribePixelRatio
    if (subscribe) {
      const dispose = subscribe.call(this.options.environment, this.handlePixelRatioChange)
      if (typeof dispose !== 'function') {
        throw new TypeError('subscribePixelRatio must return a dispose function')
      }
      this.disposePixelRatioSubscription = dispose
      return
    }
    this.view.addEventListener('resize', this.handleWindowResize, { signal })
    this.bindPixelRatioQuery()
  }

  private unbindPixelRatioQuery(): void {
    this.pixelRatioQuery?.removeEventListener('change', this.handlePixelRatioChange)
    this.pixelRatioQuery = undefined
  }
}

function createBrowserResizeObserver(callback: () => void): ResizeObserver {
  if (typeof ResizeObserver === 'undefined') throw new TypeError('ResizeObserver is unavailable')
  return new ResizeObserver(callback)
}

export function createTerminalFitController(
  options: TerminalFitControllerOptions,
): TerminalFitController {
  return TerminalFitController.create(options)
}
