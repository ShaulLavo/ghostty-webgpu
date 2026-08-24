import type { SelectionCoordinates } from '../core/selection.js'
import type { TerminalScrollbar, TerminalSelectionFormatOptions } from '../core/types.js'
import { WebGpuTerminalRenderer, type RendererFrameSnapshot } from '../render/renderer.js'
import { EventEmitter } from '../term/events.js'
import type { LinkProvider, LinkProviderRegistration } from '../term/links.js'
import { TerminalSession } from '../term/session.js'
import type {
  TerminalAppearance,
  TerminalColorScheme,
  TerminalCursorSettings,
  TerminalFittedFont,
  TerminalFontSettings,
  TerminalGrid,
  TerminalInputData,
  TerminalInputResult,
  TerminalKeyInput,
  TerminalMutationResult,
  TerminalSessionSubscription,
  TerminalTheme,
} from '../term/types.js'
import {
  createTerminalAccessibility,
  type TerminalAccessibilityController,
} from './accessibility.js'
import { createDomClipboardPolicyAdapter, writeUserSelectionToClipboard } from './clipboard.js'
import {
  createTerminalElements,
  type TerminalElements,
  type TerminalElementsOptions,
} from './elements.js'
import {
  createTerminalFitController,
  fitTerminalFont,
  type TerminalFitController,
  type TerminalFitEnvironment,
  type TerminalFitResult,
} from './fit.js'
import {
  createDomInputController,
  createDomInputLifecycleController,
  type DomInputController,
  type DomInputLifecycleController,
} from './input.js'
import { createDomLinkController, type DomLinkController } from './links.js'
import {
  createTerminalPointerController,
  type CommittedPointerLayout,
  type TerminalPointerController,
} from './pointer.js'
import { createTerminalScrollbar, type TerminalScrollbarController } from './scrollbar.js'
import { createTerminalSelectionController, type TerminalSelectionController } from './selection.js'
import type {
  GhosttyWebGpuRenderer,
  GhosttyWebGpuRendererFactory,
  GhosttyWebGpuTerminalAccessibilityOptions,
  GhosttyWebGpuTerminalEventMap,
  GhosttyWebGpuTerminalEventType,
  GhosttyWebGpuTerminalDiagnostics,
  GhosttyWebGpuTerminalLifecycle,
  GhosttyWebGpuTerminalListener,
  GhosttyWebGpuTerminalOptions,
  GhosttyWebGpuTerminalScrollbarOptions,
  GhosttyWebGpuTerminalSubscription,
} from './types.js'

type HostEmitters = {
  -readonly [TType in GhosttyWebGpuTerminalEventType]: EventEmitter<
    GhosttyWebGpuTerminalEventMap[TType]
  >
}

type Cleanup = () => void

function createHostEmitters(): HostEmitters {
  const error = new EventEmitter<GhosttyWebGpuTerminalEventMap['error']>()
  const sink = (operation: string) => (cause: unknown) => error.emit({ cause, operation })
  return {
    appearance: new EventEmitter(sink('event.appearance')),
    bell: new EventEmitter(sink('event.bell')),
    data: new EventEmitter(sink('event.data')),
    error,
    resize: new EventEmitter(sink('event.resize')),
    scroll: new EventEmitter(sink('event.scroll')),
    selection: new EventEmitter(sink('event.selection')),
    title: new EventEmitter(sink('event.title')),
  }
}

function disposeHostEmitters(emitters: HostEmitters): void {
  emitters.appearance.dispose()
  emitters.bell.dispose()
  emitters.data.dispose()
  emitters.resize.dispose()
  emitters.scroll.dispose()
  emitters.selection.dispose()
  emitters.title.dispose()
  emitters.error.dispose()
}

function invokeCleanup(cleanup: Cleanup, onError: (cause: unknown) => void): void {
  try {
    cleanup()
  } catch (cause) {
    onError(cause)
  }
}

class CleanupStack {
  private disposed = false
  private readonly entries: Cleanup[] = []

  add(cleanup: Cleanup): void {
    if (this.disposed) throw new Error('Cleanup stack is disposed')
    this.entries.push(cleanup)
  }

  dispose(onError: (cause: unknown) => void): void {
    if (this.disposed) return
    this.disposed = true
    while (this.entries.length > 0) {
      const cleanup = this.entries.pop()
      if (!cleanup) continue
      invokeCleanup(cleanup, onError)
    }
  }
}

const defaultRendererFactory: GhosttyWebGpuRendererFactory = (options) =>
  WebGpuTerminalRenderer.create(options)

const defaultScrollbarWidth = 12

function scrollbarWidth(value: number | undefined): number {
  if (value === undefined) return defaultScrollbarWidth
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError('scrollbarWidth must be a finite positive number')
}

function openAbortError(parent: HTMLElement): Error {
  const DomException = parent.ownerDocument.defaultView?.DOMException
  if (DomException) return new DomException('Terminal open was cancelled', 'AbortError')
  const error = new Error('Terminal open was cancelled')
  error.name = 'AbortError'
  return error
}

function leadingCursorColumn(snapshot: RendererFrameSnapshot): number | undefined {
  const viewport = snapshot.cursor.viewport
  if (!viewport) return undefined
  if (!viewport.wideTail) return viewport.x
  return Math.max(0, viewport.x - 1)
}

function owningWindow(element: HTMLElement): Window {
  const view = element.ownerDocument.defaultView
  if (view) return view
  throw new TypeError('Terminal elements must belong to a document with a window')
}

function effectivePixelRatio(
  element: HTMLElement,
  environment: Partial<TerminalFitEnvironment> | undefined,
): number {
  const injected = environment?.getPixelRatio
  const value = injected ? injected.call(environment) : owningWindow(element).devicePixelRatio
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError('pixelRatio must be a finite positive number')
}

function copiedFrame(snapshot: RendererFrameSnapshot): RendererFrameSnapshot {
  const viewport = snapshot.cursor.viewport
  const cursor = Object.freeze({
    ...snapshot.cursor,
    viewport: viewport ? Object.freeze({ ...viewport }) : undefined,
  })
  const rows = snapshot.rows.map((row) =>
    Object.freeze({
      cells: Object.freeze(row.cells.map((cell) => cell.slice())),
      continuations: Object.freeze(row.continuations.slice()),
      text: row.text.slice(),
      y: row.y,
    }),
  )
  return Object.freeze({ cursor, rows: Object.freeze(rows) })
}

function physicalPadding(value: number, pixelRatio: number): number {
  const result = Math.round(value * pixelRatio)
  if (Number.isSafeInteger(result) && result >= 0) return result
  throw new RangeError('Terminal padding must map to a non-negative safe device-pixel value')
}

function linkFrameSignature(
  snapshot: RendererFrameSnapshot,
  layout: CommittedPointerLayout,
): string {
  return JSON.stringify([
    layout.grid,
    layout.physical,
    snapshot.rows.map((row) => [row.y, row.cells, row.continuations]),
  ])
}

function subscriptionCleanup(subscription: TerminalSessionSubscription): Cleanup {
  return () => subscription.dispose()
}

export class GhosttyWebGpuTerminal {
  private accessibility?: TerminalAccessibilityController
  private readonly accessibilityOptions?: GhosttyWebGpuTerminalAccessibilityOptions
  private readonly cleanup = new CleanupStack()
  private readonly copySelection
  private elementsValue?: TerminalElements
  private readonly emitters = createHostEmitters()
  private fit?: TerminalFitController
  private fittedFont?: TerminalFittedFont
  private readonly fitEnvironment?: Partial<TerminalFitEnvironment>
  private generation = 0
  private input?: DomInputController
  private inputLifecycle?: DomInputLifecycleController
  private readonly keyboard
  private lastFrame?: RendererFrameSnapshot
  private lastLinkFrameSignature?: string
  private readonly linkActivationModifier
  private links?: DomLinkController
  private layoutCommitted = false
  private readonly padding
  private readonly pendingEvents: (() => void)[] = []
  private pointer?: TerminalPointerController
  private renderer?: GhosttyWebGpuRenderer
  private readonly rendererFactory: GhosttyWebGpuRendererFactory
  private scrollbar?: TerminalScrollbarController
  private readonly scrollbarOptions?: GhosttyWebGpuTerminalScrollbarOptions
  private readonly scrollbarWidthValue: number
  private selection?: TerminalSelectionController
  private stateValue: GhosttyWebGpuTerminalLifecycle = 'created'

  private constructor(
    private readonly session: TerminalSession<Event>,
    options: GhosttyWebGpuTerminalOptions,
  ) {
    this.accessibilityOptions = options.accessibility
    this.copySelection = options.copySelection
    this.fitEnvironment = options.fitEnvironment
    this.keyboard = options.keyboard
    this.linkActivationModifier = options.linkActivationModifier
    this.padding = options.padding
    this.rendererFactory = options.rendererFactory ?? defaultRendererFactory
    this.scrollbarOptions = options.scrollbar
    this.scrollbarWidthValue = scrollbarWidth(options.scrollbar?.width)
    this.cleanup.add(() => this.session.dispose())
    this.session.setClipboardWritePolicy(
      createDomClipboardPolicyAdapter({
        onError: (cause, operation) => this.reportError(cause, operation),
        policy: options.clipboardWrite,
      }),
    )
  }

  static async create(options: GhosttyWebGpuTerminalOptions = {}): Promise<GhosttyWebGpuTerminal> {
    const session = await TerminalSession.create<Event>({
      appearance: options.appearance,
      links: options.links,
      runtime: options.runtime,
    })
    try {
      return new GhosttyWebGpuTerminal(session, options)
    } catch (cause) {
      session.dispose()
      throw cause
    }
  }

  get appearance(): TerminalAppearance {
    this.ensureActive()
    return this.session.appearance
  }

  get canvas(): HTMLCanvasElement | undefined {
    return this.elementsValue?.canvas
  }

  get diagnostics(): GhosttyWebGpuTerminalDiagnostics {
    return Object.freeze({
      hasPendingFrame: this.hasPendingFrame,
      hasPendingLinkResolution: this.hasPendingLinkResolution,
      hasPendingTimer: this.hasPendingTimer,
      lifecycle: this.stateValue,
      pointerOwner: this.pointer?.owner ?? 'none',
      pressedButtonCount: this.pointer?.pressedButtonCount ?? 0,
      scrollbarVisible: this.scrollbar?.visible === true,
    })
  }

  get element(): HTMLDivElement | undefined {
    return this.elementsValue?.root
  }

  get hasPendingFrame(): boolean {
    return this.renderer?.hasPendingFrame === true || this.fit?.hasPendingFrame === true
  }

  get hasPendingLinkResolution(): boolean {
    return this.links?.hasPendingResolution === true
  }

  get hasPendingTimer(): boolean {
    if (this.renderer?.hasPendingTimer === true) return true
    if (this.scrollbar?.hasPendingTimer === true) return true
    return this.selection?.hasPendingAutoscroll === true
  }

  get lifecycle(): GhosttyWebGpuTerminalLifecycle {
    return this.stateValue
  }

  get textarea(): HTMLTextAreaElement | undefined {
    return this.elementsValue?.textarea
  }

  async open(parent: HTMLElement): Promise<void> {
    this.ensureCreated()
    this.stateValue = 'opening'
    const generation = this.nextGeneration()
    let renderer: GhosttyWebGpuRenderer | undefined
    try {
      const elements = this.installElements(parent)
      renderer = await this.createRenderer(elements)
      if (!this.isOpening(generation)) {
        const staleRenderer = renderer
        renderer = undefined
        invokeCleanup(
          () => staleRenderer.dispose(),
          () => {},
        )
        throw openAbortError(parent)
      }
      this.installRenderer(renderer)
      renderer = undefined
      this.renderer?.setDocumentVisible(elements.root.ownerDocument.visibilityState !== 'hidden')
      this.subscribeToSession()
      this.installAccessibility(elements)
      this.installScrollbar(elements)
      this.installInput(elements, parent)
      this.installFit(elements)
      this.installPointer(elements)
      this.installLinks(elements)
      this.replayLastFrame()
      this.stateValue = 'open'
      this.flushPendingEvents()
    } catch (cause) {
      if (renderer)
        invokeCleanup(
          () => renderer?.dispose(),
          () => {},
        )
      const cancelled = !this.isOpening(generation)
      this.dispose()
      if (cancelled) throw openAbortError(parent)
      throw cause
    }
  }

  on<TType extends GhosttyWebGpuTerminalEventType>(
    type: TType,
    listener: GhosttyWebGpuTerminalListener<TType>,
  ): GhosttyWebGpuTerminalSubscription {
    this.ensureActive()
    const emitter = this.emitters[type] as EventEmitter<GhosttyWebGpuTerminalEventMap[TType]>
    return emitter.subscribe(listener)
  }

  onData(listener: GhosttyWebGpuTerminalListener<'data'>): GhosttyWebGpuTerminalSubscription {
    return this.on('data', listener)
  }

  onResize(listener: GhosttyWebGpuTerminalListener<'resize'>): GhosttyWebGpuTerminalSubscription {
    return this.on('resize', listener)
  }

  frameSnapshot(): RendererFrameSnapshot | undefined {
    this.ensureActive()
    if (!this.lastFrame) return undefined
    return copiedFrame(this.lastFrame)
  }

  visibleLines(): readonly string[] {
    this.ensureActive()
    const rows = this.lastFrame?.rows ?? []
    return Object.freeze(rows.map((row) => row.text.slice()))
  }

  registerLinkProvider(provider: LinkProvider<Event>): LinkProviderRegistration {
    this.ensureActive()
    const registration = this.session.registerLinkProvider(provider)
    this.refreshLinks()
    let disposed = false
    return Object.freeze({
      dispose: () => {
        if (disposed) return
        disposed = true
        registration.dispose()
        this.refreshLinks()
      },
      token: registration.token,
    })
  }

  write(data: TerminalInputData): TerminalMutationResult {
    this.ensureOpen()
    this.invalidateLinks()
    const result = this.session.write(data)
    if (this.stateValue !== 'open') return result
    this.accessibility?.notifyOutput()
    this.updateScrollbar()
    this.renderer?.notifyWrite()
    return result
  }

  writeln(data: TerminalInputData): TerminalMutationResult {
    this.ensureOpen()
    this.invalidateLinks()
    const result = this.session.writeln(data)
    if (this.stateValue !== 'open') return result
    this.accessibility?.notifyOutput()
    this.updateScrollbar()
    this.renderer?.notifyWrite()
    return result
  }

  sendInput(data: TerminalInputData): TerminalInputResult {
    this.ensureOpen()
    return this.session.sendInput(data)
  }

  paste(data: TerminalInputData): TerminalInputResult {
    this.ensureOpen()
    return this.session.paste(data)
  }

  key(input: TerminalKeyInput): TerminalInputResult {
    this.ensureOpen()
    return this.session.key(input)
  }

  focus(): void {
    this.ensureOpen()
    this.elementsValue?.textarea.focus({ preventScroll: true })
  }

  blur(): void {
    this.ensureOpen()
    this.elementsValue?.textarea.blur()
  }

  reset(): TerminalMutationResult {
    this.ensureOpen()
    this.pointer?.cancel()
    return this.session.reset()
  }

  scrollToTop(): TerminalMutationResult {
    this.ensureOpen()
    return this.session.scrollToTop()
  }

  scrollToBottom(): TerminalMutationResult {
    this.ensureOpen()
    return this.session.scrollToBottom()
  }

  scrollBy(delta: number): TerminalMutationResult {
    this.ensureOpen()
    return this.session.scrollBy(delta)
  }

  scrollToRow(row: number): TerminalMutationResult {
    this.ensureOpen()
    return this.session.scrollToRow(row)
  }

  getSelection(options: TerminalSelectionFormatOptions = {}): string | undefined {
    this.ensureOpen()
    return this.session.getSelection(options)
  }

  selectionCoordinates(): Readonly<SelectionCoordinates> | undefined {
    this.ensureOpen()
    return this.session.selectionCoordinates()
  }

  clearSelection(): boolean {
    this.ensureOpen()
    this.pointer?.cancel()
    return this.session.clearSelection()
  }

  selectAll(): boolean {
    this.ensureOpen()
    this.pointer?.cancel()
    return this.session.selectAll().selectionChanged
  }

  focusNextLink(): Promise<boolean> {
    this.ensureOpen()
    return this.links?.focusNextLink() ?? Promise.resolve(false)
  }

  setColorScheme(colorScheme: TerminalColorScheme): TerminalMutationResult {
    this.ensureOpen()
    return this.session.setColorScheme(colorScheme)
  }

  setCursor(cursor: Partial<TerminalCursorSettings>): TerminalMutationResult {
    this.ensureOpen()
    return this.session.setCursor(cursor)
  }

  setFont(font: Partial<TerminalFontSettings>): TerminalMutationResult {
    this.ensureOpen()
    return this.session.setFont(font)
  }

  setTheme(theme: TerminalTheme): TerminalMutationResult {
    this.ensureOpen()
    return this.session.setTheme(theme)
  }

  dispose(): void {
    if (this.stateValue === 'disposed' || this.stateValue === 'disposing') return
    this.stateValue = 'disposing'
    this.nextGeneration()
    this.pendingEvents.length = 0
    this.cleanup.dispose((cause) => this.emitters.error.emit({ cause, operation: 'dispose' }))
    this.accessibility = undefined
    this.fit = undefined
    this.fittedFont = undefined
    this.input = undefined
    this.inputLifecycle = undefined
    this.lastFrame = undefined
    this.lastLinkFrameSignature = undefined
    this.layoutCommitted = false
    this.links = undefined
    this.pointer = undefined
    this.renderer = undefined
    this.scrollbar = undefined
    this.selection = undefined
    this.elementsValue = undefined
    this.stateValue = 'disposed'
    disposeHostEmitters(this.emitters)
  }

  private installElements(parent: HTMLElement): TerminalElements {
    const options: TerminalElementsOptions = { padding: this.padding }
    const elements = createTerminalElements(parent, options)
    this.elementsValue = elements
    this.cleanup.add(() => elements.dispose())
    return elements
  }

  private async createRenderer(elements: TerminalElements): Promise<GhosttyWebGpuRenderer> {
    const appearance = this.session.appearance
    const grid = appearance.grid
    const font = fitTerminalFont(
      elements.canvas.ownerDocument,
      appearance.font,
      effectivePixelRatio(elements.canvas, this.fitEnvironment),
    )
    this.fittedFont = font
    return this.rendererFactory(
      {
        canvas: elements.canvas,
        columns: grid.columns,
        cursorBlink: appearance.cursor.blink,
        font,
        onFrame: (snapshot) => this.handleFrame(snapshot),
        renderState: this.session.renderState,
        rows: grid.rows,
        theme: appearance.rendererTheme,
      },
      elements.signal,
    )
  }

  private installRenderer(renderer: GhosttyWebGpuRenderer): void {
    this.renderer = renderer
    this.cleanup.add(() => renderer.dispose())
  }

  private subscribeToSession(): void {
    this.trackSubscription(
      this.session.on('appearance', ({ appearance }) => this.handleAppearance(appearance)),
    )
    this.trackSubscription(this.session.on('bell', () => this.emitHostEvent('bell', undefined)))
    this.trackSubscription(
      this.session.on('data', ({ bytes }) => this.emitHostEvent('data', Uint8Array.from(bytes))),
    )
    this.trackSubscription(this.session.on('error', (error) => this.emitHostEvent('error', error)))
    this.trackSubscription(this.session.on('renderRequest', () => this.handleRenderRequest()))
    this.trackSubscription(this.session.on('resize', ({ grid }) => this.handleResize(grid)))
    this.trackSubscription(this.session.on('scroll', (scroll) => this.handleScroll(scroll)))
    this.trackSubscription(
      this.session.on('selection', (selection) => this.handleSelection(selection)),
    )
    this.trackSubscription(
      this.session.on('title', ({ title }) => this.emitHostEvent('title', title)),
    )
  }

  private trackSubscription(subscription: TerminalSessionSubscription): void {
    this.cleanup.add(subscriptionCleanup(subscription))
  }

  private installAccessibility(elements: TerminalElements): void {
    const options = this.accessibilityOptions
    const accessibility = createTerminalAccessibility({
      label: options?.label,
      liveRegionMaxCharacters: options?.liveRegionMaxCharacters,
      liveRegionMaxEntries: options?.liveRegionMaxEntries,
      root: elements.root,
      signal: elements.signal,
      textarea: elements.textarea,
    })
    this.accessibility = accessibility
    this.cleanup.add(() => accessibility.dispose())
  }

  private installScrollbar(elements: TerminalElements): void {
    const options = this.scrollbarOptions
    const scrollbar = createTerminalScrollbar({
      actions: this.session,
      clock: options?.clock,
      fadeDelayMs: options?.fadeDelayMs,
      minThumbSize: options?.minThumbSize,
      onError: (cause, operation) => this.reportError(cause, `scrollbar.${operation}`),
      root: elements.root,
      signal: elements.signal,
      snapshot: this.session.scrollbar,
      width: this.scrollbarWidthValue,
    })
    this.scrollbar = scrollbar
    this.cleanup.add(() => scrollbar.dispose())
    this.installScrollbarFirstRefusal(elements)
  }

  private installScrollbarFirstRefusal(elements: TerminalElements): void {
    const options = { capture: true, signal: elements.signal }
    elements.root.addEventListener('pointerdown', this.handleScrollbarPointerDown, options)
    elements.root.addEventListener('pointermove', this.handleScrollbarPointerMove, options)
    elements.root.addEventListener('pointerup', this.handleScrollbarPointerUp, options)
    elements.root.addEventListener('pointercancel', this.handleScrollbarPointerUp, options)
    elements.root.addEventListener('wheel', this.handleScrollbarWheel, {
      ...options,
      passive: false,
    })
  }

  private installInput(elements: TerminalElements, parent: HTMLElement): void {
    let input: DomInputController | undefined
    if (this.keyboard !== false) {
      const view = owningWindow(parent)
      const copySelection =
        this.copySelection ?? ((text: string) => writeUserSelectionToClipboard(view, text))
      input = createDomInputController({
        copySelection,
        onError: (cause, operation) => this.reportError(cause, `input.${operation}`),
        session: this.session,
        shortcuts: this.keyboard?.shortcuts,
        signal: elements.signal,
        textarea: elements.textarea,
      })
      this.input = input
      this.cleanup.add(() => input?.dispose())
    }
    const lifecycle = createDomInputLifecycleController({
      onDocumentVisible: (visible) => this.renderer?.setDocumentVisible(visible),
      onError: (cause, operation) => this.reportError(cause, `input.${operation}`),
      onFocused: (focused) => this.handleFocused(focused),
      onResetTransientState: () => input?.resetTransientState(),
      session: this.session,
      signal: elements.signal,
      textarea: elements.textarea,
    })
    this.inputLifecycle = lifecycle
    this.cleanup.add(() => lifecycle.dispose())
  }

  private installFit(elements: TerminalElements): void {
    const fit = createTerminalFitController({
      container: elements.root,
      environment: this.fitEnvironment,
      font: this.session.appearance.font,
      getScrollbarWidth: () => this.scrollbarWidthValue,
      onFit: (result) => this.applyFit(result),
      padding: this.padding,
      paddingElement: elements.canvas,
      signal: elements.signal,
    })
    this.fit = fit
    this.cleanup.add(() => fit.dispose())
  }

  private installPointer(elements: TerminalElements): void {
    const selection = createTerminalSelectionController({
      onError: (cause, operation) => this.reportError(cause, operation),
      session: this.session,
      view: owningWindow(elements.canvas),
    })
    let pointer: TerminalPointerController
    try {
      pointer = createTerminalPointerController({
        canvas: elements.canvas,
        getLayout: () => this.committedPointerLayout(),
        onError: (cause, operation) => this.reportError(cause, operation),
        selection,
        session: {
          mouse: (input) => this.session.mouse(input),
          mouseTracking: () => this.session.mouseTracking,
          resetMouseTracking: () => this.session.resetMouseTracking(),
          scrollBy: (delta) => this.session.scrollBy(delta),
        },
        signal: elements.signal,
      })
    } catch (cause) {
      selection.dispose()
      throw cause
    }
    this.selection = selection
    this.pointer = pointer
    this.cleanup.add(() => pointer.dispose())
  }

  private installLinks(elements: TerminalElements): void {
    const links = createDomLinkController({
      activationModifier: this.linkActivationModifier,
      canvas: elements.canvas,
      getLayout: () => this.committedPointerLayout(),
      onError: (cause, operation) => this.reportError(cause, `link.${operation}`),
      root: elements.root,
      session: this.session,
      signal: elements.signal,
    })
    this.links = links
    this.cleanup.add(() => links.dispose())
  }

  private applyFit(result: TerminalFitResult): void {
    if (this.stateValue !== 'open' && this.stateValue !== 'opening') return
    const paddingChanged = this.elementsValue?.setPadding(result.padding) === true
    const scrollbarWidthChanged = this.scrollbar?.setWidth(result.scrollbarWidth) === true
    this.renderer?.setFont(result.font)
    this.fittedFont = result.font
    this.layoutCommitted = true
    if (paddingChanged || scrollbarWidthChanged) this.invalidateLinks()
    this.session.resize(result.grid)
    if (this.stateValue !== 'open') return
    this.replayLastFrame()
    this.updateScrollbar()
  }

  private handleAppearance(appearance: TerminalAppearance): void {
    const renderer = this.renderer
    renderer?.setCursorBlinkEnabled(appearance.cursor.blink)
    renderer?.setTheme(appearance.rendererTheme)
    this.fit?.setFont(appearance.font)
    this.emitHostEvent('appearance', appearance)
  }

  private handleResize(grid: TerminalGrid): void {
    this.invalidateLinks()
    this.renderer?.resize({ columns: grid.columns, rows: grid.rows })
    this.updateScrollbar()
    this.emitHostEvent('resize', { cols: grid.columns, rows: grid.rows })
  }

  private handleScroll(scroll: GhosttyWebGpuTerminalEventMap['scroll']): void {
    this.invalidateLinks()
    this.renderer?.notifyScroll()
    this.updateScrollbar(scroll.scrollbar)
    this.emitHostEvent('scroll', scroll)
  }

  private handleSelection(selection: GhosttyWebGpuTerminalEventMap['selection']): void {
    this.renderer?.notifySelectionChange()
    this.emitHostEvent('selection', selection)
  }

  private handleFocused(focused: boolean): void {
    this.renderer?.setFocused(focused)
    if (!focused) this.pointer?.cancel()
  }

  private handleRenderRequest(): void {
    this.invalidateLinks()
    this.renderer?.schedule()
  }

  private replayLastFrame(): void {
    const snapshot = this.lastFrame
    if (!snapshot) return
    this.handleFrame(snapshot)
  }

  private handleFrame(snapshot: RendererFrameSnapshot): void {
    if (this.stateValue !== 'open' && this.stateValue !== 'opening') return
    this.lastFrame = snapshot
    const scrollbar = this.session.scrollbar
    this.runUiOperation('frame.caret', () => this.positionTextarea(snapshot))
    this.runUiOperation('frame.links', () => this.updateLinkFrame(snapshot))
    this.runUiOperation('frame.accessibility', () =>
      this.accessibility?.update(snapshot, scrollbar),
    )
    this.runUiOperation('frame.scrollbar', () => this.scrollbar?.update(scrollbar))
  }

  private invalidateLinks(): void {
    this.lastLinkFrameSignature = undefined
    this.links?.invalidate()
  }

  private refreshLinks(): void {
    this.invalidateLinks()
    const snapshot = this.lastFrame
    if (!snapshot) return
    this.updateLinkFrame(snapshot)
  }

  private updateLinkFrame(snapshot: RendererFrameSnapshot): void {
    const links = this.links
    const layout = this.committedPointerLayout()
    if (!links || !layout) return
    const signature = linkFrameSignature(snapshot, layout)
    if (signature === this.lastLinkFrameSignature) return
    links.updateFrame(snapshot)
    this.lastLinkFrameSignature = signature
  }

  private committedPointerLayout(): CommittedPointerLayout | undefined {
    const elements = this.elementsValue
    if (!elements || !this.layoutCommitted) return undefined
    const grid = this.session.grid
    const font = this.fittedFont
    if (!font) return undefined
    const ratio = font.pixelRatio
    const padding = elements.padding
    const physical = Object.freeze({
      deviceCellHeight: font.deviceCellHeight,
      deviceCellWidth: font.deviceCellWidth,
      paddingBottom: physicalPadding(padding.bottom, ratio),
      paddingLeft: physicalPadding(padding.left, ratio),
      paddingRight: physicalPadding(padding.right, ratio),
      paddingTop: physicalPadding(padding.top, ratio),
      screenHeight: 0,
      screenWidth: 0,
    })
    const dimensions = Object.freeze({
      ...physical,
      screenHeight:
        physical.paddingTop + font.deviceCellHeight * grid.rows + physical.paddingBottom,
      screenWidth:
        physical.paddingLeft + font.deviceCellWidth * grid.columns + physical.paddingRight,
    })
    return Object.freeze({
      canvas: elements.canvas,
      grid: Object.freeze({ ...grid }),
      physical: dimensions,
    })
  }

  private updateScrollbar(snapshot?: Readonly<TerminalScrollbar>): void {
    const scrollbar = this.scrollbar
    if (!scrollbar || this.stateValue === 'disposed') return
    scrollbar.update(snapshot ?? this.session.scrollbar)
  }

  private runUiOperation(operation: string, action: () => unknown): void {
    try {
      action()
    } catch (cause) {
      this.reportError(cause, operation)
    }
  }

  private readonly handleScrollbarPointerDown = (event: PointerEvent): void => {
    if (this.scrollbar?.consumePointerDown(event)) return
    const elements = this.elementsValue
    if (!elements || event.target !== elements.canvas) return
    elements.textarea.focus({ preventScroll: true })
  }

  private readonly handleScrollbarPointerMove = (event: PointerEvent): void => {
    this.scrollbar?.consumePointerMove(event)
  }

  private readonly handleScrollbarPointerUp = (event: PointerEvent): void => {
    this.scrollbar?.consumePointerUp(event)
  }

  private readonly handleScrollbarWheel = (event: WheelEvent): void => {
    const scrollbar = this.scrollbar
    if (!scrollbar || scrollbar.consumeWheel(event)) return
    if (event.target !== this.elementsValue?.canvas) return
    scrollbar.notifyActivity()
  }

  private positionTextarea(snapshot: RendererFrameSnapshot): void {
    const elements = this.elementsValue
    if (!elements) return
    if (this.stateValue !== 'open' && this.stateValue !== 'opening') return
    this.lastFrame = snapshot
    const column = leadingCursorColumn(snapshot)
    const viewport = snapshot.cursor.viewport
    if (column === undefined || !viewport) return
    const grid = this.session.grid
    elements.positionTextarea({
      x: elements.padding.left + column * grid.cellWidth,
      y: elements.padding.top + viewport.y * grid.cellHeight,
    })
  }

  private reportError(cause: unknown, operation: string): void {
    if (this.stateValue === 'disposed') return
    this.emitHostEvent('error', { cause, operation })
  }

  private emitHostEvent<TType extends GhosttyWebGpuTerminalEventType>(
    type: TType,
    event: GhosttyWebGpuTerminalEventMap[TType],
  ): void {
    const emitter = this.emitters[type] as EventEmitter<GhosttyWebGpuTerminalEventMap[TType]>
    if (this.stateValue === 'open') {
      emitter.emit(event)
      return
    }
    if (this.stateValue !== 'opening') return
    this.pendingEvents.push(() => emitter.emit(event))
  }

  private flushPendingEvents(): void {
    const events = this.pendingEvents.splice(0)
    for (const emit of events) {
      if (this.stateValue !== 'open') return
      emit()
    }
  }

  private nextGeneration(): number {
    this.generation += 1
    return this.generation
  }

  private isOpening(generation: number): boolean {
    return this.stateValue === 'opening' && this.generation === generation
  }

  private ensureCreated(): void {
    if (this.stateValue === 'created') return
    throw new Error(`Terminal cannot open while lifecycle is ${this.stateValue}`)
  }

  private ensureActive(): void {
    if (this.stateValue !== 'disposed' && this.stateValue !== 'disposing') return
    throw new Error('Terminal has been disposed')
  }

  private ensureOpen(): void {
    if (this.stateValue === 'open') return
    throw new Error(`Terminal is not open; lifecycle is ${this.stateValue}`)
  }
}
