import { loadBidiMapper } from '../bidi/loader.js'
import { fontMetricsEqual } from '../term/font-metrics.js'
import { createGhosttyError } from '../core/error.js'
import type { SelectionCoordinates, SelectionPoint } from '../core/selection.js'
import { createExtensionDispatch, ExtensionManager } from '../extensions/manager.js'
import type {
  Extension,
  ExtensionHandle,
  TerminalInputEvent,
  TerminalInputHandler,
} from '../extensions/types.js'
import type {
  ReadLinesOptions,
  TerminalGeometry,
  TerminalTextMeasurement,
  TerminalLine,
  TerminalScrollbar,
  TerminalSelectionFormatOptions,
} from '../core/types.js'
import type { RendererFrameSnapshot, RendererTextFrameSnapshot } from '../render/shared/types.js'
import type { InactiveCursorStyle } from '../render/shared/cursor.js'
import { bindCanvasImage, bindStartupBackend, CanvasImageRelay } from './canvas-image.js'
import {
  attachCanvasImage,
  observeDisplayedFrame,
  startupBackend,
  startupCanvas,
  wakeStartupHandoff,
} from '../render/shared/displayed-frame.js'
import { TerminalHostInput } from './terminal-host-input.js'
import { TerminalHostPointer } from './terminal-host-pointer.js'
import { TerminalHostEvents } from './terminal-host-events.js'
import { observeTerminalVisibility } from './terminal-visibility.js'
import {
  browserOutputTimingClock,
  outputTimingLimits,
  OutputTimingTracker,
  type OutputTimingLimits,
} from './output-timing.js'
import type { LinkProvider, LinkProviderRegistration } from '../term/links.js'
import type { LocalTerminalExecution } from './execution-local.js'
import { TerminalWriteQueue } from './write-queue.js'
import type { TerminalBatchedWriteOptions } from './write-queue.js'
import type {
  TerminalSubmittedFrame,
  TerminalSubmittedSnapshot,
  TerminalSubmittedText,
} from './submitted-frame.js'
import type { TerminalApi, TerminalResult } from './terminal-api.js'
import type { WorkerTerminalExecution } from '../worker/execution.js'
import { observeWorkerLayout, workerLayout } from './worker-layout.js'
import { TerminalWorkerError, workerError } from '../transport/worker-errors.js'
import type {
  TerminalAppearance,
  TerminalAppearanceOptions,
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
import { TerminalHostAccessibility } from './terminal-host-accessibility.js'
import { createDomClipboardPolicyAdapter } from './clipboard.js'
import { CleanupStack, invokeCleanup, type Cleanup } from './cleanup.js'
import {
  createTerminalElements,
  type TerminalElementPadding,
  type TerminalElements,
  type TerminalElementsOptions,
} from './elements.js'
import {
  createTerminalFitController,
  fitTerminalFont,
  gridEquals,
  measureTerminalFit,
  terminalPixelRatio,
  type TerminalFitController,
  type TerminalFitEnvironment,
  type TerminalFitMeasurementResult,
  type TerminalFitResult,
} from './fit.js'
import { observeFontResources } from './font-resources.js'
import type { LigatureFinder, TerminalLigatures } from '../render/shared/ligatures/finder.js'
import { createTerminalScrollbar, type TerminalScrollbarController } from './scrollbar.js'
import type {
  GhosttyWebGpuRenderer,
  GhosttyWebGpuRendererFactory,
  GhosttyWebGpuTerminalEventMap,
  GhosttyWebGpuTerminalEventType,
  GhosttyWebGpuTerminalDiagnostics,
  GhosttyWebGpuTerminalLifecycle,
  GhosttyWebGpuTerminalFromSessionOptions,
  GhosttyWebGpuTerminalListener,
  GhosttyWebGpuTerminalOptions,
  GhosttyWebGpuTerminalPointerHooks,
  GhosttyWebGpuTerminalScrollbarOptions,
  GhosttyWebGpuTerminalSubscription,
  TerminalInputModes,
  TerminalInputConnection,
  TerminalGeneratedInput,
} from './types.js'

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

// Renderers leave default cells transparent; the root fills the grid, padding and fit remainder.
function applyRootBackground(root: HTMLElement, appearance: TerminalAppearance): void {
  const { r, g, b } = appearance.rendererTheme.background
  root.style.backgroundColor = `rgb(${r} ${g} ${b} / ${appearance.backgroundOpacity})`
}

function subscriptionCleanup(subscription: TerminalSessionSubscription): Cleanup {
  return () => subscription.dispose()
}

function fittedFontSettingsEqual(
  fitted: TerminalFittedFont | undefined,
  settings: TerminalFontSettings,
): boolean {
  if (!fitted) return false
  const current = fitted.settings
  return (
    fontMetricsEqual(current.metrics, settings.metrics) &&
    current.boldWeight === settings.boldWeight &&
    current.family === settings.family &&
    current.letterSpacing === settings.letterSpacing &&
    current.lineHeight === settings.lineHeight &&
    current.size === settings.size &&
    current.weight === settings.weight
  )
}

export class TerminalHost<Mode extends 'sync' | 'async' = 'sync'> implements TerminalApi<Mode> {
  private readonly accessibility: TerminalHostAccessibility
  private documentVisible = true
  private elementVisible = true
  private readonly renderWhenOffscreen: boolean
  private publicFrameSource?: TerminalSubmittedSnapshot
  private publicFrame?: TerminalSubmittedFrame
  private readonly autoFit: boolean
  private readonly cleanup = new CleanupStack()
  private readonly compositorAsset?: string | URL
  private elementsValue?: TerminalElements
  private fit?: TerminalFitController
  private fittedFont?: TerminalFittedFont
  private workerCanvasSize?: {
    readonly canvas: HTMLCanvasElement
    readonly width: number
    readonly height: number
  }
  private readonly canvasImages = new CanvasImageRelay((cause) =>
    this.reportError(cause, 'renderer.canvasImage'),
  )
  private readonly fitEnvironment?: Partial<TerminalFitEnvironment>
  private extensions?: ExtensionManager
  private readonly extensionDispatch = createExtensionDispatch()
  private readonly events = new TerminalHostEvents(
    {
      appearance: () => this.execution.appearance,
      grid: () => this.execution.grid,
      lifecycle: () => this.stateValue,
    },
    this.extensionDispatch,
  )
  private generation = 0
  private readonly input: TerminalHostInput
  private inputOwner?: TerminalInputConnection & { readonly handler: TerminalInputHandler }
  private inactiveCursorStyle?: InactiveCursorStyle
  private lastFrame?: RendererTextFrameSnapshot
  private layoutCommitted = false
  private readonly padding
  private readonly pointer: TerminalHostPointer
  private readonly pointerHooks?: GhosttyWebGpuTerminalPointerHooks
  private renderer?: GhosttyWebGpuRenderer
  private readonly rendererFactory?: GhosttyWebGpuRendererFactory
  private readonly bidi: boolean
  private readonly textBlink: boolean
  private readonly ligatures: TerminalLigatures | undefined
  private ligatureFinder?: Promise<LigatureFinder | undefined>
  private readonly rendererMode: GhosttyWebGpuTerminalOptions['rendererMode']
  private readonly presentation: GhosttyWebGpuTerminalOptions['presentation']
  private readonly outputTimingLimits: OutputTimingLimits
  private outputTimingTracker?: OutputTimingTracker
  private timedWorkerWrite?: { readonly sequence: number; readonly control: number }
  private scrollbar?: TerminalScrollbarController
  private readonly scrollbarOptions?: GhosttyWebGpuTerminalScrollbarOptions | false
  private readonly scrollbarWidthValue: number
  private stateValue: GhosttyWebGpuTerminalLifecycle = 'created'
  private readonly writeQueue: TerminalWriteQueue<TerminalMutationResult>

  protected constructor(
    private readonly execution: LocalTerminalExecution | WorkerTerminalExecution,
    options: GhosttyWebGpuTerminalFromSessionOptions,
    defaultRendererFactory?: GhosttyWebGpuRendererFactory,
  ) {
    bindCanvasImage(this, this.canvasImages)
    bindStartupBackend(this, () => this.resolveStartupBackend())
    this.cleanup.add(() => this.events.disposeText())
    this.accessibility = new TerminalHostAccessibility(options.accessibility, {
      frame: () => this.execution.submittedFrame,
      visible: () => this.documentVisible,
      onError: (cause, operation) => this.reportError(cause, operation),
    })
    this.autoFit = options.autoFit !== false
    this.compositorAsset = options.compositorAsset
    this.fitEnvironment = options.fitEnvironment
    this.input = new TerminalHostInput(
      {
        copySelection: options.copySelection,
        inputHooks: options.inputHooks,
        keyboard: options.keyboard,
      },
      {
        execution,
        claimKey: this.claimDomKey,
        claimText: this.claimText,
        elements: () => this.elementsValue,
        font: () => this.fittedFont,
        isPresent: () => this.stateValue === 'open' || this.stateValue === 'opening',
        lastFrame: () => this.lastFrame,
        noteInput: () => this.writeQueue.noteInput(),
        onError: (cause, operation) => this.reportError(cause, operation),
        setDocumentVisible: (visible) => this.setDocumentVisible(visible),
        setFocused: (focused) => this.handleFocused(focused),
        setReducedMotion: (reduced) => this.renderer?.setReducedMotion?.(reduced),
      },
    )
    this.padding = options.padding
    this.pointerHooks = options.pointerHooks
    this.pointer = new TerminalHostPointer(
      {
        execution,
        elements: () => this.elementsValue,
        layoutCommitted: () => this.layoutCommitted,
        onError: (cause, operation) => this.reportError(cause, operation),
        wakeHandoff: () => this.wakeStartupHandoff(),
      },
      options.linkActivationModifier,
    )
    this.rendererFactory = options.rendererFactory ?? defaultRendererFactory
    this.bidi = options.bidi ?? false
    this.textBlink = options.textBlink ?? false
    this.ligatures = options.ligatures
    this.renderWhenOffscreen = options.renderWhenOffscreen === true
    this.rendererMode = options.rendererMode
    this.presentation = options.presentation
    this.outputTimingLimits = outputTimingLimits(options.outputTiming)
    this.writeQueue = new TerminalWriteQueue(
      (data) => this.writeParsed(data, true),
      options.writeQueue,
    )
    this.scrollbarOptions = options.scrollbar
    this.scrollbarWidthValue =
      options.scrollbar === false ? 0 : scrollbarWidth(options.scrollbar?.width)

    const elements = options.elements
    if (elements) {
      this.elementsValue = elements
      this.cleanup.add(() => elements.dispose())
    }
    try {
      if (this.execution.kind === 'sync')
        this.execution.setClipboardWritePolicy(
          createDomClipboardPolicyAdapter({
            onError: (cause, operation) => this.reportError(cause, operation),
            policy: options.clipboardWrite,
          }),
        )
      if (options.extensions?.length) this.extensionManager().install(options.extensions)
    } catch (cause) {
      this.dispose()
      throw cause
    }
  }

  use<Api = void>(extension: Extension<Api>): TerminalResult<Mode, ExtensionHandle<Api>> {
    if (this.execution.kind === 'async') {
      return this.result(
        Promise.resolve().then(() => {
          this.ensureActive()
          return this.extensionManager().use(extension)
        }),
      )
    }
    this.ensureActive()
    return this.result(this.extensionManager().use(extension))
  }

  connectInput(handler: TerminalInputHandler): TerminalResult<Mode, TerminalInputConnection> {
    if (this.execution.kind === 'async') {
      return this.result(
        Promise.resolve().then(() => {
          this.ensureActive()
          throw workerError('capability', 'connectInput', { actor: 'worker' })
        }),
      )
    }
    this.ensureActive()
    if (typeof handler !== 'function')
      throw createGhosttyError('input.connect', 'Input owner must be a function')
    if (this.inputOwner)
      throw createGhosttyError('input.connect', 'Terminal original input already has an owner')
    const controller = new AbortController()
    const connection = {
      handler,
      signal: controller.signal,
      dispose: () => {
        if (this.inputOwner === connection) this.inputOwner = undefined
        controller.abort()
      },
    }
    this.inputOwner = connection
    return this.result(connection)
  }

  private extensionManager(): ExtensionManager {
    this.extensions ??= new ExtensionManager({
      dispatch: this.extensionDispatch,
      terminal: this,
      registerLinkProvider: (provider) => this.registerLinkProvider(provider),
      onError: (cause, operation) => this.events.emitError(cause, operation),
    })
    return this.extensions
  }

  private claimInput(input: TerminalInputEvent): boolean {
    const owner = this.inputOwner
    if (owner) {
      let claimed = false
      try {
        const decision: unknown = owner.handler(input)
        if (decision !== 'claim' && decision !== 'pass') {
          void Promise.resolve(decision).catch((cause: unknown) =>
            this.reportError(cause, 'input.owner'),
          )
          throw createGhosttyError(
            'input.owner',
            'Input owner must return claim or pass synchronously',
          )
        }
        claimed = decision === 'claim'
      } catch (cause) {
        this.reportError(cause, 'input.owner')
      }
      if (claimed || owner.signal.aborted || this.stateValue !== 'open') return true
    }
    return (this.extensionDispatch.input?.(input) ?? false) || this.stateValue !== 'open'
  }

  private readonly claimDomKey = (event: KeyboardEvent): boolean => {
    if (!this.inputOwner && !this.extensionDispatch.input) return false
    return this.claimInput({ type: 'key', event })
  }

  private readonly claimText = (
    type: 'paste' | 'text' | 'composition',
    data: TerminalInputData,
  ): boolean => {
    if (!this.inputOwner && !this.extensionDispatch.input) return false
    if (type === 'composition') return this.claimInput({ type, text: data as string })
    return this.claimInput({ type, data })
  }

  get inputModes(): TerminalInputModes {
    this.ensureActive()
    if (this.execution.kind !== 'sync')
      throw workerError('capability', 'inputModes', { actor: 'worker' })
    return {
      alternateScreen: this.execution.alternateScreen,
      mouseReporting: this.execution.pointer.mouseTracking(),
    }
  }

  static fromWorker(
    execution: WorkerTerminalExecution,
    options: GhosttyWebGpuTerminalFromSessionOptions,
  ): TerminalHost<'async'> {
    return new TerminalHost<'async'>(execution, options)
  }

  private emptyInputResult(): TerminalResult<Mode, TerminalInputResult> {
    const empty = new Uint8Array()
    return this.result(this.execution.kind === 'async' ? Promise.resolve(empty) : empty)
  }

  private result<Value>(value: Value | Promise<Value>): TerminalResult<Mode, Value> {
    return value as TerminalResult<Mode, Value>
  }

  get appearance(): TerminalAppearance {
    this.ensureActive()
    return this.execution.appearance
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
      pointerOwner: this.pointer.owner,
      pressedButtonCount: this.pointer.pressedButtonCount,
      rendererBackend:
        this.execution.kind === 'async' ? this.execution.backend : this.renderer?.backend,
      desynchronized: this.renderer?.desynchronized === true,
      scrollbarVisible: this.scrollbar?.visible === true,
    })
  }

  get element(): HTMLDivElement | undefined {
    return this.elementsValue?.root
  }

  get hasPendingFrame(): boolean {
    if (this.execution.kind === 'async') return this.execution.hasPendingRequest
    return this.renderer?.hasPendingFrame === true || this.fit?.hasPendingFrame === true
  }

  get hasPendingLinkResolution(): boolean {
    return this.pointer.hasPendingResolution
  }

  get hasPendingTimer(): boolean {
    if (this.renderer?.hasPendingTimer === true) return true
    if (this.scrollbar?.hasPendingTimer === true) return true
    return this.pointer.hasPendingAutoscroll
  }

  get lifecycle(): GhosttyWebGpuTerminalLifecycle {
    return this.stateValue
  }

  get pendingWriteBytes(): number {
    return this.writeQueue.pendingBytes
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
      applyRootBackground(elements.root, this.execution.appearance)
      this.subscribeToSession()
      const bidiMapper = this.bidi ? await loadBidiMapper() : undefined
      const initialFit = this.prepareInitialFit(elements)
      const initialAppearance = this.execution.appearance
      renderer = await this.createRenderer(elements, initialAppearance, initialFit?.result)
      if (!this.isOpening(generation)) {
        const staleRenderer = renderer
        renderer = undefined
        invokeCleanup(
          () => staleRenderer?.dispose(),
          () => {},
        )
        throw openAbortError(parent)
      }
      if (renderer) this.installRenderer(renderer)
      renderer = undefined
      this.reconcileRendererAppearance(elements, initialAppearance)
      this.setDocumentVisible(elements.root.ownerDocument.visibilityState !== 'hidden')
      this.installVisibility(elements)
      this.cleanup.add(() => this.accessibility.dispose())
      this.accessibility.attach(elements)
      this.installScrollbar(elements, initialFit?.result.scrollbarWidth)
      this.input.attach(elements, (cleanup) => this.cleanup.add(cleanup))
      const initialFitResult =
        initialFit &&
        this.execution.appearance === initialAppearance &&
        gridEquals(this.execution.grid, initialFit.result.grid)
          ? initialFit.result
          : undefined
      this.installFit(elements, initialFitResult, initialFit?.desiredPadding)
      this.cleanup.add(() => this.pointer.dispose())
      this.pointer.attach(elements, bidiMapper)
      this.replayLastFrame()
      this.stateValue = 'open'
      this.events.emit('open', elements.root)
      this.events.flushPending()
    } catch (cause) {
      if (renderer)
        invokeCleanup(
          () => renderer?.dispose(),
          () => {},
        )
      const cancelled = !this.isOpening(generation)
      await Promise.resolve(this.dispose()).catch(() => {})
      if (cancelled) throw openAbortError(parent)
      throw cause
    }
  }

  on<TType extends GhosttyWebGpuTerminalEventType>(
    type: TType,
    listener: GhosttyWebGpuTerminalListener<TType>,
  ): GhosttyWebGpuTerminalSubscription {
    this.ensureActive()
    if (type !== 'outputTiming') return this.events.on(type, listener)
    this.outputTimingTracker ??= this.createOutputTimingTracker()
    const subscription = this.events.on(type, listener)
    return {
      dispose: () => {
        subscription.dispose()
        this.releaseOutputTiming()
      },
    }
  }

  // The last listener leaving drops recorded input and any open burst.
  private releaseOutputTiming(): void {
    if (this.events.hasListeners('outputTiming')) return
    this.outputTimingTracker?.dispose()
    this.outputTimingTracker = undefined
    this.timedWorkerWrite = undefined
  }

  onData(listener: GhosttyWebGpuTerminalListener<'data'>): GhosttyWebGpuTerminalSubscription {
    return this.on('data', listener)
  }

  onResize(listener: GhosttyWebGpuTerminalListener<'resize'>): GhosttyWebGpuTerminalSubscription {
    return this.on('resize', listener)
  }

  onFrame(listener: GhosttyWebGpuTerminalListener<'frame'>): GhosttyWebGpuTerminalSubscription {
    return this.on('frame', listener)
  }

  onText(listener: (text: TerminalSubmittedText) => void): GhosttyWebGpuTerminalSubscription {
    this.ensureActive()
    return this.events.onText(this.execution.submittedFrame?.frame ?? 0, listener)
  }

  get submittedFrame(): TerminalSubmittedFrame | undefined {
    this.ensureActive()
    const frame = this.execution.submittedFrame
    if (!frame) return undefined
    if (frame === this.publicFrameSource) return this.publicFrame
    this.publicFrameSource = frame
    this.publicFrame = Object.freeze({
      frame: frame.frame,
      nativeRevision: frame.nativeRevision,
      snapshotVersion: frame.snapshotVersion,
      layout: frame.layout,
      grid: frame.grid,
      font: frame.font,
      padding: frame.padding,
      theme: frame.theme,
      cursor: frame.cursor,
      paintedCursor: frame.paintedCursor,
      selection: frame.selection,
      scrollbar: frame.scrollbar,
    })
    return this.publicFrame
  }

  geometry(): TerminalResult<Mode, TerminalGeometry> {
    this.ensureActive()
    return this.result(this.execution.geometry())
  }

  measure(text: string): TerminalResult<Mode, number> {
    this.ensureActive()
    return this.result(this.execution.measure(text))
  }

  measureTexts(texts: readonly string[]): TerminalResult<Mode, TerminalTextMeasurement> {
    this.ensureActive()
    return this.result(this.execution.measureTexts(texts))
  }

  writeAndReadGeometry(data: TerminalInputData): TerminalResult<Mode, TerminalGeometry> {
    this.ensureOpen()
    this.writeQueue.flush()
    this.pointer.invalidateLinks()
    const timing = this.observedOutputTiming()
    const sequence = timing?.output()
    const geometry = this.execution.writeAndReadGeometry(data)
    if (timing) this.markOutputApplied(timing, sequence!)
    if (this.stateValue !== 'open') return this.result(geometry)
    this.updateScrollbar()
    this.renderer?.notifyWrite()
    return this.result(geometry)
  }

  frameSnapshot(): TerminalResult<Mode, RendererFrameSnapshot | undefined> {
    this.ensureActive()
    return this.result(this.execution.frameSnapshot())
  }

  captureViewport(): TerminalResult<Mode, string | undefined> {
    this.ensureActive()
    const parent = this.elementsValue?.root.parentElement
    if (!parent)
      return this.result(this.execution.kind === 'async' ? Promise.resolve(undefined) : undefined)
    return this.result(this.execution.captureViewport(parent.clientWidth, parent.clientHeight))
  }

  /** Count retained scrollback and visible rows on the active screen. */
  lineCount(): TerminalResult<Mode, number> {
    this.ensureActive()
    return this.result(this.execution.lineCount())
  }

  /** Read clamped, oldest-first active-screen rows [start, end), capped at TERMINAL_READ_LINES_MAX_ROWS.
   * trimRight defaults to true. Upstream has no inactive-screen selector. */
  readLines(
    start: number,
    end: number,
    options: ReadLinesOptions = {},
  ): TerminalResult<Mode, readonly TerminalLine[]> {
    this.ensureActive()
    return this.result(this.execution.readLines(start, end, options))
  }

  visibleLines(): readonly string[] {
    this.ensureActive()
    const rows = this.readFrame()?.rows ?? []
    return Object.freeze(rows.map((row) => row.text.slice()))
  }

  registerLinkProvider(provider: LinkProvider<Event>): LinkProviderRegistration {
    this.ensureActive()
    const registration = this.execution.registerLinkProvider(provider)
    this.pointer.refreshLinks()
    let disposed = false
    return Object.freeze({
      dispose: () => {
        if (disposed) return
        disposed = true
        registration.dispose()
        this.pointer.refreshLinks()
      },
      token: registration.token,
    })
  }

  write(data: TerminalInputData): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    this.writeQueue.flush()
    return this.result(this.writeParsed(data, false))
  }

  writeBatched(
    data: TerminalInputData,
    options?: TerminalBatchedWriteOptions,
  ): Promise<TerminalMutationResult> {
    this.ensureOpen()
    return this.writeQueue.write(data, options)
  }

  private writeParsed(
    data: TerminalInputData,
    owned: boolean,
  ): TerminalMutationResult | Promise<TerminalMutationResult> {
    this.pointer.invalidateLinks()
    const timing = this.observedOutputTiming()
    const sequence = timing?.output()
    const result =
      owned && this.execution.kind === 'async'
        ? this.execution.writeOwned(data as Uint8Array)
        : this.execution.write(data)
    if (timing) this.markOutputApplied(timing, sequence!)
    if (this.stateValue !== 'open') return result
    this.updateScrollbar()
    this.renderer?.notifyWrite()
    return result
  }

  writeln(data: TerminalInputData): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    this.writeQueue.flush()
    this.pointer.invalidateLinks()
    const timing = this.observedOutputTiming()
    const sequence = timing?.output()
    const result = this.execution.writeln(data)
    if (timing) this.markOutputApplied(timing, sequence!)
    if (this.stateValue !== 'open') return this.result(result)
    this.updateScrollbar()
    this.renderer?.notifyWrite()
    return this.result(result)
  }

  sendInput(data: TerminalInputData): TerminalResult<Mode, TerminalInputResult> {
    this.ensureOpen()
    this.writeQueue.noteInput()
    if (this.claimText('text', data)) return this.emptyInputResult()
    return this.result(this.execution.sendInput(data))
  }

  paste(data: TerminalInputData): TerminalResult<Mode, TerminalInputResult> {
    this.ensureOpen()
    this.writeQueue.noteInput()
    if (this.claimText('paste', data)) return this.emptyInputResult()
    return this.result(this.execution.paste(data))
  }

  key(input: TerminalKeyInput): TerminalResult<Mode, TerminalInputResult> {
    this.ensureOpen()
    this.writeQueue.noteInput()
    if (
      (this.inputOwner || this.extensionDispatch.input) &&
      this.claimInput({ type: 'key', input })
    )
      return this.emptyInputResult()
    return this.result(this.execution.key(input))
  }

  sendGeneratedInput(input: TerminalGeneratedInput): TerminalResult<Mode, TerminalInputResult> {
    this.ensureOpen()
    this.writeQueue.noteInput()
    if (input.type === 'key') return this.result(this.execution.key(input.input))
    if (input.type === 'paste') return this.result(this.execution.paste(input.data))
    return this.result(
      this.execution.sendInput(input.type === 'composition' ? input.text : input.data),
    )
  }

  focus(): void {
    this.ensureOpen()
    this.elementsValue?.textarea.focus({ preventScroll: true })
  }

  blur(): void {
    this.ensureOpen()
    this.elementsValue?.textarea.blur()
  }

  reset(): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    this.writeQueue.flush()
    this.input.resetTransientState()
    this.pointer.cancel()
    return this.result(this.execution.reset())
  }

  refresh(startRow: number, endRow: number): TerminalResult<Mode, void> {
    this.ensureOpen()
    if (this.execution.kind === 'async')
      return this.result(this.execution.request('refresh', [startRow, endRow]))
    this.renderer?.refreshRows?.(startRow, endRow)
    return this.result(undefined)
  }

  clearTextureAtlas(): TerminalResult<Mode, void> {
    this.ensureOpen()
    if (this.execution.kind === 'async')
      return this.result(this.execution.request('clearTextureAtlas', []))
    this.renderer?.clearTextureAtlas?.()
    return this.result(undefined)
  }

  scrollToTop(): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    return this.result(this.execution.scrollToTop())
  }

  scrollToBottom(): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    return this.result(this.execution.scrollToBottom())
  }

  scrollBy(delta: number): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    return this.result(this.execution.scrollBy(delta))
  }

  scrollToRow(row: number): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    return this.result(this.execution.scrollToRow(row))
  }

  getSelection(
    options: TerminalSelectionFormatOptions = {},
  ): TerminalResult<Mode, string | undefined> {
    this.ensureOpen()
    return this.result(this.execution.getSelection(options))
  }

  selectionCoordinates(): TerminalResult<Mode, Readonly<SelectionCoordinates> | undefined> {
    this.ensureOpen()
    return this.result(this.execution.selectionCoordinates())
  }

  clearSelection(): TerminalResult<Mode, boolean> {
    this.ensureOpen()
    this.pointer.cancel()
    return this.result(this.execution.clearSelection())
  }

  selectAll(): TerminalResult<Mode, boolean> {
    this.ensureOpen()
    this.pointer.cancel()
    const result = this.execution.selectAll()
    return this.result(
      result instanceof Promise
        ? result.then((value) => value.selectionChanged)
        : result.selectionChanged,
    )
  }

  selectRange(start: SelectionPoint, end: SelectionPoint): TerminalResult<Mode, boolean> {
    this.ensureOpen()
    this.pointer.cancel()
    const result = this.execution.selectRange(start, end)
    return this.result(
      result instanceof Promise
        ? result.then((value) => value.selectionChanged)
        : result.selectionChanged,
    )
  }

  selectLines(startRow: number, endRow: number): TerminalResult<Mode, boolean> {
    this.ensureOpen()
    this.pointer.cancel()
    const result = this.execution.selectLines(startRow, endRow)
    return this.result(
      result instanceof Promise
        ? result.then((value) => value.selectionChanged)
        : result.selectionChanged,
    )
  }

  focusNextLink(): Promise<boolean> {
    this.ensureOpen()
    return this.pointer.focusNextLink()
  }

  setColorScheme(colorScheme: TerminalColorScheme): TerminalResult<Mode, TerminalMutationResult> {
    return this.setAppearance({ colorScheme })
  }

  setCursor(cursor: Partial<TerminalCursorSettings>): TerminalResult<Mode, TerminalMutationResult> {
    return this.setAppearance({ cursor })
  }

  setAccessibilityEnabled(enabled: boolean): boolean {
    this.ensureActive()
    return this.accessibility.setEnabled(enabled, this.elementsValue)
  }

  setCursorInactiveStyle(style: InactiveCursorStyle | undefined): TerminalResult<Mode, boolean> {
    this.ensureActive()
    if (this.execution.kind === 'async')
      return this.result(this.execution.request('inactiveCursor', [style]))
    if (this.inactiveCursorStyle === style) return this.result(false)
    this.inactiveCursorStyle = style
    this.renderer?.setInactiveCursorStyle?.(style)
    return this.result(true)
  }

  setFont(font: Partial<TerminalFontSettings>): TerminalResult<Mode, TerminalMutationResult> {
    return this.setAppearance({ font })
  }

  setTheme(theme: TerminalTheme): TerminalResult<Mode, TerminalMutationResult> {
    return this.setAppearance({ theme })
  }

  setAppearance(options: TerminalAppearanceOptions): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    this.writeQueue.flush()
    return this.result(this.execution.setAppearance(options))
  }

  dispose(): TerminalResult<Mode, void> {
    if (this.stateValue === 'disposed' || this.stateValue === 'disposing')
      return this.result(this.execution.kind === 'async' ? this.execution.dispose() : undefined)
    this.stateValue = 'disposing'
    this.canvasImages.dispose()
    this.writeQueue.dispose()
    this.nextGeneration()
    this.events.discardPending()
    this.outputTimingTracker?.dispose()
    this.outputTimingTracker = undefined
    this.timedWorkerWrite = undefined
    this.inputOwner?.dispose()
    this.extensions?.dispose()
    this.cleanup.dispose((cause) => this.events.emitError(cause, 'dispose'))
    this.fit = undefined
    this.fittedFont = undefined
    this.lastFrame = undefined
    this.layoutCommitted = false
    this.renderer = undefined
    this.scrollbar = undefined
    this.elementsValue = undefined
    this.workerCanvasSize = undefined
    this.stateValue = 'disposed'
    this.events.dispose()
    return this.result(this.execution.dispose())
  }

  attachOutputPort(port: MessagePort): Promise<void> {
    this.ensureOpen()
    if (this.execution.kind === 'sync')
      throw workerError('capability', 'attachOutputPort', { actor: 'main' })
    return this.execution.attachOutputPort(port)
  }

  fenceOutput(sequence: number): Promise<void> {
    this.ensureOpen()
    if (this.execution.kind === 'sync')
      throw workerError('capability', 'fenceOutput', { actor: 'main' })
    return this.execution.fenceOutput(sequence)
  }

  private installElements(parent: HTMLElement): TerminalElements {
    const installed = this.elementsValue
    if (installed) {
      if (installed.root.parentElement === parent) return installed
      throw new TypeError('Precreated terminal elements must be direct children of the open parent')
    }
    const options: TerminalElementsOptions = { padding: this.padding }
    const elements = createTerminalElements(parent, options)
    this.elementsValue = elements
    this.cleanup.add(() => elements.dispose())
    return elements
  }

  private prepareInitialFit(elements: TerminalElements): TerminalFitMeasurementResult | undefined {
    if (this.execution.kind !== 'sync' || !this.autoFit) return undefined
    // Keep an uninitialized <canvas> (default 300x150) from inflating a height:auto host during open.
    const previousPosition = elements.canvas.style.getPropertyValue('position')
    const previousPositionPriority = elements.canvas.style.getPropertyPriority('position')
    elements.canvas.style.setProperty('position', 'absolute', 'important')
    let measured: TerminalFitMeasurementResult | undefined
    try {
      measured = measureTerminalFit({
        container: elements.root,
        environment: this.fitEnvironment,
        font: this.execution.appearance.font,
        getScrollbarWidth: () => this.scrollbarWidthValue,
        padding: this.padding,
        paddingElement: elements.canvas,
      })
    } finally {
      if (previousPosition) {
        elements.canvas.style.setProperty('position', previousPosition, previousPositionPriority)
      } else {
        elements.canvas.style.removeProperty('position')
      }
    }
    if (!measured) return undefined
    const { result } = measured
    elements.setPadding(result.padding)
    elements.canvas.style.width = `${result.grid.columns * result.font.cssCellWidth}px`
    elements.canvas.style.height = `${result.grid.rows * result.font.cssCellHeight}px`
    this.execution.commitLayout(result.font, result.padding)
    this.fittedFont = result.font
    this.layoutCommitted = true
    this.execution.resize(result.grid)
    return measured
  }

  private async createRenderer(
    elements: TerminalElements,
    appearance: TerminalAppearance,
    initialFit?: TerminalFitResult,
  ): Promise<GhosttyWebGpuRenderer | undefined> {
    if (this.execution.kind === 'async') {
      if (this.rendererMode && this.rendererMode !== 'auto')
        throw new TerminalWorkerError({
          code: 'capability',
          operation: 'renderer.create',
          status: 501,
          why: 'Canvas paint modes run in the main-thread terminal.',
          fix: 'Use the main terminal entry or automatic worker rendering.',
          internal: { actor: 'worker', capability: 'canvas2d' },
        })
      if (this.presentation === 'immediate')
        throw new TerminalWorkerError({
          code: 'capability',
          operation: 'renderer.create',
          status: 501,
          why: 'Immediate presentation runs in the main-thread terminal.',
          fix: 'Use the main terminal entry or frame presentation.',
          internal: { actor: 'worker', capability: 'presentation' },
        })
      this.execution.setFrameListener((snapshot) => this.handleFrame(snapshot))
      this.fittedFont = await this.execution.open(
        elements,
        workerLayout(elements, 1, this.scrollbarWidthValue, this.autoFit, this.fitEnvironment),
      )
      this.layoutCommitted = true
      return undefined
    }
    const rendererFactory = this.rendererFactory
    if (!rendererFactory) throw new Error('Local terminal requires a renderer factory')
    const grid = appearance.grid
    const font =
      initialFit?.font ??
      fitTerminalFont(
        elements.canvas.ownerDocument,
        appearance.font,
        terminalPixelRatio(elements.canvas, this.fitEnvironment),
      )
    this.fittedFont = font
    this.execution.commitLayout(font, elements.padding)
    this.input.updatePreeditAppearance(font, appearance.rendererTheme)
    // One finder per terminal survives renderer restores and fallbacks.
    // The font reader loads only when ligatures are on.
    this.ligatureFinder ??= this.ligatures
      ? import('../render/shared/ligatures/finder.js').then((module) =>
          module.resolveLigatureFinder(this.ligatures, font),
        )
      : Promise.resolve(undefined)
    const ligatures = await this.ligatureFinder
    return this.execution.createRenderer(
      rendererFactory,
      {
        canvas: elements.canvas,
        compositorAsset: this.compositorAsset,
        columns: grid.columns,
        cursorBlink: appearance.cursor.blink,
        textBlink: this.textBlink,
        font,
        ligatures,
        onError: (cause) => this.reportError(cause, 'renderer.restore'),
        onCleanUpdate: () => {
          this.noteDrawn()
          this.handleCleanUpdate()
        },
        [attachCanvasImage]: () => this.canvasImages.attach(),
        [observeDisplayedFrame]: (snapshot) => this.handleFrame(snapshot),
        [startupCanvas]: elements.adoptCanvas && {
          adopt: (canvas) => this.replaceRendererCanvas(elements, canvas),
          canAdopt: () => this.pointer.canAdoptCanvas,
        },
        retainDisplayedText: true,
        needsFrameRows: () => this.pointer.needsFrame || this.events.hasTextListeners,
        onRowsChanged: (rows) => {
          if (!this.events.hasListeners('frame') && !this.extensionDispatch.events.frame) return
          this.events.emit('frame', Object.freeze({ rows }))
        },
        replaceCanvas: elements.replaceCanvas
          ? () => this.replaceRendererCanvas(elements)
          : undefined,
        rows: grid.rows,
        rendererMode: this.rendererMode,
        presentation: this.presentation,
        theme: appearance.rendererTheme,
      },
      elements.signal,
    )
  }

  private reconcileRendererAppearance(
    elements: TerminalElements,
    initialAppearance: TerminalAppearance,
  ): void {
    if (this.execution.kind === 'async') return
    const appearance = this.execution.appearance
    if (appearance === initialAppearance) return
    const font = fitTerminalFont(
      elements.canvas.ownerDocument,
      appearance.font,
      terminalPixelRatio(elements.canvas, this.fitEnvironment),
    )
    this.fittedFont = font
    this.execution.commitLayout(font, elements.padding)
    this.input.updatePreeditAppearance(font, appearance.rendererTheme)
    this.renderer?.setCursorBlinkEnabled(appearance.cursor.blink)
    this.renderer?.setFont(font)
    this.renderer?.setTheme(appearance.rendererTheme)
    this.renderer?.resize({
      columns: appearance.grid.columns,
      rows: appearance.grid.rows,
    })
  }

  private observedOutputTiming(): OutputTimingTracker | undefined {
    const tracker = this.outputTimingTracker
    if (!tracker || !this.events.hasListeners('outputTiming')) return undefined
    return tracker
  }

  private markOutputApplied(timing: OutputTimingTracker, sequence: number): void {
    if (this.execution.kind === 'sync') {
      timing.applied(sequence)
      return
    }
    // The worker can submit the frame holding a write before it replies to that write.
    this.timedWorkerWrite = { sequence, control: this.execution.requestedControl }
  }

  private noteDrawn(): void {
    const timing = this.observedOutputTiming()
    if (!timing) return
    const write = this.timedWorkerWrite
    if (
      write &&
      this.execution.kind === 'async' &&
      this.execution.submittedControl >= write.control
    )
      timing.applied(write.sequence)
    timing.drawn()
  }

  private createOutputTimingTracker(): OutputTimingTracker {
    return new OutputTimingTracker({
      clock: browserOutputTimingClock(),
      limits: this.outputTimingLimits,
      visible: () => this.renderVisible,
      renderHeld: () => this.execution.renderHeld,
      measuresPresentation: this.execution.kind === 'sync',
      pendingFrame: () => this.execution.kind === 'sync' && this.renderer?.hasPendingFrame === true,
      describe: () => {
        const diagnostics = this.diagnostics
        return {
          desynchronized: diagnostics.desynchronized,
          presentation: this.presentation ?? 'frame',
          rendererBackend: diagnostics.rendererBackend,
        }
      },
      emit: (timing) => this.events.emit('outputTiming', timing),
    })
  }

  private installRenderer(renderer: GhosttyWebGpuRenderer): void {
    this.renderer = renderer
    renderer.setInactiveCursorStyle?.(this.inactiveCursorStyle)
    this.cleanup.add(() => renderer.dispose())
  }

  private subscribeToSession(): void {
    this.trackSubscription(
      this.execution.on('appearance', ({ appearance }) => this.handleAppearance(appearance)),
    )
    this.trackSubscription(this.execution.on('bell', () => this.events.emit('bell', undefined)))
    this.trackSubscription(
      this.execution.on('data', ({ bytes, origin }) => {
        if (origin === 'input') {
          this.writeQueue.noteInput()
          this.observedOutputTiming()?.input()
        }
        this.events.emit('data', Object.freeze({ bytes: Uint8Array.from(bytes), origin }))
      }),
    )
    this.trackSubscription(
      this.execution.on('error', (error) => {
        this.events.emit('error', error)
        // The opening catch owns cleanup so its rejection retains the actor failure.
        if (
          this.stateValue === 'open' &&
          this.execution.kind === 'async' &&
          this.execution.failed
        ) {
          void this.execution.dispose().catch(() => {})
          void Promise.resolve(this.dispose()).catch(() => {})
        }
      }),
    )
    this.trackSubscription(this.execution.on('renderRequest', () => this.handleRenderRequest()))
    this.trackSubscription(this.execution.on('resize', ({ grid }) => this.handleResize(grid)))
    this.trackSubscription(this.execution.on('scroll', (scroll) => this.handleScroll(scroll)))
    this.trackSubscription(
      this.execution.on('selection', (selection) => this.handleSelection(selection)),
    )
    this.trackSubscription(
      this.execution.on('title', ({ title }) => this.events.emit('title', title)),
    )
  }

  private trackSubscription(subscription: TerminalSessionSubscription): void {
    this.cleanup.add(subscriptionCleanup(subscription))
  }

  private installScrollbar(elements: TerminalElements, initialWidth?: number): void {
    const options = this.scrollbarOptions
    // These capture listeners also focus input on canvas presses, so they stay without a scrollbar.
    if (options === false) return this.installScrollbarFirstRefusal(elements)
    const scrollbar = createTerminalScrollbar({
      actions: this.execution.scroll,
      clock: options?.clock,
      fadeDelayMs: options?.fadeDelayMs,
      minThumbSize: options?.minThumbSize,
      onError: (cause, operation) => this.reportError(cause, `scrollbar.${operation}`),
      root: elements.root,
      signal: elements.signal,
      snapshot: this.execution.scrollbar,
      width: initialWidth ?? this.scrollbarWidthValue,
    })
    this.scrollbar = scrollbar
    this.cleanup.add(() => scrollbar.dispose())
    this.installScrollbarFirstRefusal(elements)
  }

  private installScrollbarFirstRefusal(elements: TerminalElements): void {
    const options = { capture: true, signal: elements.signal }
    elements.root.addEventListener('pointerdown', this.handleScrollbarPointerDown, options)
    elements.root.addEventListener('mousedown', this.handleCanvasMouseDown, options)
    elements.root.addEventListener('pointermove', this.handleScrollbarPointerMove, options)
    elements.root.addEventListener('pointerup', this.handleScrollbarPointerUp, options)
    elements.root.addEventListener('pointercancel', this.handleScrollbarPointerUp, options)
    elements.root.addEventListener('wheel', this.handleScrollbarWheel, {
      ...options,
      passive: false,
    })
  }

  private installFit(
    elements: TerminalElements,
    initialFit?: TerminalFitResult,
    initialDesiredPadding?: TerminalElementPadding,
  ): void {
    if (this.execution.kind === 'async') {
      const execution = this.execution
      let identity = 1
      const update = () => {
        const layout = workerLayout(
          elements,
          ++identity,
          this.scrollbarWidthValue,
          this.autoFit,
          this.fitEnvironment,
        )
        this.writeQueue.flush()
        void execution.layout(layout).catch((cause: unknown) => this.reportError(cause, 'layout'))
      }
      this.cleanup.add(observeWorkerLayout(elements, update, this.fitEnvironment))
      return
    }
    const refreshFontResources = () => {
      this.runUiOperation('appearance.font-resources', () => {
        if (this.autoFit) this.fit?.refreshFontResources()
        if (!this.autoFit) this.measureFixedFont(this.execution.appearance.font)
        this.renderer?.clearTextureAtlas?.()
      })
    }
    observeFontResources({
      fonts: elements.root.ownerDocument.fonts,
      family: () => this.execution.appearance.font.family,
      refresh: refreshFontResources,
      signal: elements.signal,
    })
    if (!this.autoFit) {
      const font = this.fittedFont
      if (!font) throw new Error('Fixed terminal layout requires a measured font')
      this.commitFixedFont(font)
      return
    }
    const fit = createTerminalFitController({
      container: elements.root,
      environment: this.fitEnvironment,
      font: this.execution.appearance.font,
      getScrollbarWidth: () => this.scrollbarWidthValue,
      initialResult: initialFit,
      onFit: (result) => this.applyFit(result),
      padding: this.padding ?? initialDesiredPadding,
      paddingElement: elements.canvas,
      signal: elements.signal,
    })
    this.fit = fit
    this.cleanup.add(() => fit.dispose())
  }

  private wakeStartupHandoff(): void {
    const renderer = this.renderer
    if (renderer && wakeStartupHandoff in renderer) {
      ;(renderer as { [wakeStartupHandoff](): void })[wakeStartupHandoff]()
    }
  }

  private resolveStartupBackend(): Promise<'canvas2d' | 'dom' | 'webgl2' | 'webgpu' | undefined> {
    const renderer = this.renderer
    if (renderer && startupBackend in renderer) {
      return (
        renderer as {
          [startupBackend](): Promise<'canvas2d' | 'dom' | 'webgl2' | 'webgpu' | undefined>
        }
      )[startupBackend]()
    }
    return Promise.resolve(this.diagnostics.rendererBackend)
  }

  private applyFit(result: TerminalFitResult): void {
    if (this.execution.kind === 'async') return
    if (this.stateValue !== 'open' && this.stateValue !== 'opening') return
    const paddingChanged = this.elementsValue?.setPadding(result.padding) === true
    const scrollbarWidthChanged = this.scrollbar?.setWidth(result.scrollbarWidth) === true
    this.execution.commitLayout(result.font, result.padding)
    this.renderer?.setFont(result.font)
    this.fittedFont = result.font
    this.layoutCommitted = true
    if (paddingChanged || scrollbarWidthChanged) this.pointer.invalidateLinks()
    this.writeQueue.flush()
    this.execution.resize(result.grid)
    // Padding can change without native cells changing; submit its new layout with owned rows.
    if (paddingChanged || scrollbarWidthChanged)
      this.renderer?.refreshRows?.(0, result.grid.rows - 1)
    if (this.stateValue !== 'open') return
    this.replayLastFrame()
    this.updateScrollbar()
  }

  private commitFixedFont(font: TerminalFittedFont): void {
    if (this.execution.kind === 'async') return
    if (this.stateValue !== 'open' && this.stateValue !== 'opening') return
    const grid = this.execution.grid
    this.execution.commitLayout(font, this.elementsValue!.padding)
    this.renderer?.setFont(font)
    this.fittedFont = font
    this.layoutCommitted = true
    this.writeQueue.flush()
    this.execution.resize({
      cellHeight: font.cssCellHeight,
      cellWidth: font.cssCellWidth,
      columns: grid.columns,
      pixelRatio: font.pixelRatio,
      rows: grid.rows,
    })
    if (this.stateValue !== 'open') return
    this.replayLastFrame()
    this.updateScrollbar()
  }

  private remeasureFixedFont(settings: TerminalFontSettings): void {
    if (fittedFontSettingsEqual(this.fittedFont, settings)) return
    this.measureFixedFont(settings)
  }

  private measureFixedFont(settings: TerminalFontSettings): void {
    const canvas = this.elementsValue?.canvas
    if (!canvas) return
    const font = fitTerminalFont(
      canvas.ownerDocument,
      settings,
      terminalPixelRatio(canvas, this.fitEnvironment),
    )
    this.commitFixedFont(font)
  }

  private handleAppearance(appearance: TerminalAppearance): void {
    const root = this.elementsValue?.root
    if (root) applyRootBackground(root, appearance)
    if (this.execution.kind === 'async') {
      this.events.emit('appearance', appearance)
      return
    }
    const renderer = this.renderer
    if (this.autoFit) this.fit?.setFont(appearance.font)
    if (!this.autoFit) {
      this.runUiOperation('appearance.font', () => this.remeasureFixedFont(appearance.font))
    }
    renderer?.setCursorBlinkEnabled(appearance.cursor.blink)
    renderer?.setTheme(appearance.rendererTheme)
    this.events.emit('appearance', appearance)
  }

  private handleResize(grid: TerminalGrid): void {
    if (this.accessibility.enabled) this.accessibility.noteResize(this.execution.revision)
    this.pointer.invalidateLinks()
    this.renderer?.resize({ columns: grid.columns, rows: grid.rows })
    this.updateScrollbar()
    this.events.emit('resize', { cols: grid.columns, rows: grid.rows })
  }

  private handleScroll(scroll: GhosttyWebGpuTerminalEventMap['scroll']): void {
    this.accessibility.noteScroll(scroll.scrollbar)
    this.pointer.invalidateLinks()
    this.renderer?.notifyScroll()
    this.updateScrollbar(scroll.scrollbar)
    this.events.emit('scroll', scroll)
  }

  private handleSelection(selection: GhosttyWebGpuTerminalEventMap['selection']): void {
    this.renderer?.notifySelectionChange()
    this.events.emit('selection', selection)
  }

  private get renderVisible(): boolean {
    return this.documentVisible && this.elementVisible
  }

  private installVisibility(elements: TerminalElements): void {
    if (this.renderWhenOffscreen) return
    this.cleanup.add(
      observeTerminalVisibility(elements.root, (visible) => this.setElementVisible(visible)),
    )
  }

  private setElementVisible(visible: boolean): void {
    if (this.stateValue === 'disposed' || this.elementVisible === visible) return
    this.elementVisible = visible
    this.synchronizeRenderVisibility()
  }

  private setDocumentVisible(visible: boolean): void {
    this.documentVisible = visible
    this.accessibility.visibilityChanged(visible)
    this.synchronizeRenderVisibility()
  }

  private synchronizeRenderVisibility(): void {
    const visible = this.renderVisible
    if (visible) this.outputTimingTracker?.resume()
    if (this.execution.kind === 'async') {
      void this.execution
        .request('visible', [visible])
        .catch((cause: unknown) => this.reportError(cause, 'visibility'))
      return
    }
    this.renderer?.setDocumentVisible(visible)
  }

  private handleFocused(focused: boolean): void {
    this.renderer?.setFocused(focused)
    if (focused) {
      this.input.positionAtLastFrame('focus.caret')
      return
    }
    this.pointer.cancel()
  }

  private handleRenderRequest(): void {
    this.pointer.invalidateLinks()
    this.renderer?.schedule()
  }

  private readFrame(): RendererTextFrameSnapshot | undefined {
    return this.execution.textFrame()
  }

  private replayLastFrame(): void {
    const snapshot = this.lastFrame
    if (!snapshot) return
    this.updateFrameUi(snapshot)
  }

  private replaceRendererCanvas(
    elements: TerminalElements,
    replacement?: HTMLCanvasElement,
  ): HTMLCanvasElement {
    const canvas = this.pointer.replaceCanvas(elements, replacement)
    this.replayLastFrame()
    return canvas
  }

  private handleCleanUpdate(): void {
    if (this.execution.kind !== 'sync') return
    this.execution.confirmCleanUpdate()
    if (!this.pointer.needsFrame) return
    const snapshot = this.readFrame()
    if (snapshot) this.pointer.updateLinkFrame(snapshot)
  }

  private handleFrame(snapshot: RendererTextFrameSnapshot): void {
    if (this.stateValue !== 'open' && this.stateValue !== 'opening') return
    if (!snapshot.renderHeld) this.noteDrawn()
    this.updateFrameUi(this.execution.kind === 'sync' ? this.execution.submit(snapshot) : snapshot)
    this.events.publishText(this.execution.submittedFrame)
    this.accessibility.schedule()
    if (
      this.execution.kind === 'async' &&
      (this.events.hasListeners('frame') || this.extensionDispatch.events.frame)
    )
      this.events.emit('frame', {
        rows: this.execution.submittedFrame?.rowPatches.map((row) => row.y) ?? [],
      })
  }

  private updateFrameUi(snapshot: RendererTextFrameSnapshot): void {
    this.lastFrame = snapshot
    const summary = this.execution.submittedFrame
    const canvas = this.elementsValue?.canvas
    if (summary && canvas && this.execution.kind === 'async') {
      const width = summary.grid.columns * summary.font.cssCellWidth
      const height = summary.grid.rows * summary.font.cssCellHeight
      const previous = this.workerCanvasSize
      const widthChanged = previous?.canvas !== canvas || previous?.width !== width
      const heightChanged = previous?.canvas !== canvas || previous?.height !== height
      if (widthChanged) canvas.style.width = `${width}px`
      if (heightChanged) canvas.style.height = `${height}px`
      if (widthChanged || heightChanged) this.workerCanvasSize = { canvas, width, height }
    }
    const scrollbar = summary?.scrollbar ?? this.execution.scrollbar
    if (summary) this.input.updatePreeditAppearance(summary.font, summary.theme)
    this.runUiOperation('frame.caret', () => this.input.positionTextarea(snapshot))
    this.runUiOperation('frame.links', () => this.pointer.acceptFrame(snapshot))
    this.runUiOperation('frame.scrollbar', () => this.scrollbar?.update(scrollbar))
  }

  private updateScrollbar(snapshot?: Readonly<TerminalScrollbar>): void {
    const scrollbar = this.scrollbar
    if (!scrollbar || this.stateValue === 'disposed') return
    scrollbar.update(
      this.execution.submittedFrame?.scrollbar ?? snapshot ?? this.execution.scrollbar,
    )
  }

  private runUiOperation(operation: string, action: () => unknown): void {
    try {
      action()
    } catch (cause) {
      this.reportError(cause, operation)
    }
  }

  private readonly handleCanvasMouseDown = (event: MouseEvent): void => {
    if (event.target !== this.elementsValue?.canvas) return
    // iOS sends compatibility mousedown after a cancelled touch pointerdown; its default blurs input.
    event.preventDefault()
  }

  private readonly handleScrollbarPointerDown = (event: PointerEvent): void => {
    if (this.blockRejectedPointerEvent(event)) return
    if (this.scrollbar?.consumePointerDown(event)) return
    const elements = this.elementsValue
    if (!elements || event.target !== elements.canvas) return
    elements.textarea.focus({ preventScroll: true })
  }

  private readonly handleScrollbarPointerMove = (event: PointerEvent): void => {
    if (this.blockRejectedPointerEvent(event)) return
    this.scrollbar?.consumePointerMove(event)
  }

  private readonly handleScrollbarPointerUp = (event: PointerEvent): void => {
    if (this.blockRejectedPointerEvent(event)) return
    this.scrollbar?.consumePointerUp(event)
  }

  private readonly handleScrollbarWheel = (event: WheelEvent): void => {
    if (this.blockRejectedPointerEvent(event)) return
    const scrollbar = this.scrollbar
    if (!scrollbar || scrollbar.consumeWheel(event)) return
    if (event.target !== this.elementsValue?.canvas) return
    scrollbar.notifyActivity()
  }

  private blockRejectedPointerEvent(event: PointerEvent | WheelEvent): boolean {
    if (this.allowPointerEvent(event)) return false
    event.stopPropagation()
    return true
  }

  private allowPointerEvent(event: PointerEvent | WheelEvent): boolean {
    return this.evaluatePointerEvent(event)
  }

  private evaluatePointerEvent(event: PointerEvent | WheelEvent): boolean {
    if (event.type === 'wheel' && !this.invokeCustomWheelEvent(event as WheelEvent)) return false
    return this.invokeAllowPointerEvent(event)
  }

  private invokeCustomWheelEvent(event: WheelEvent): boolean {
    const predicate = this.pointerHooks?.customWheelEvent
    if (!predicate) return true
    try {
      return predicate(event) !== false
    } catch (cause) {
      event.stopPropagation()
      throw cause
    }
  }

  private invokeAllowPointerEvent(event: PointerEvent | WheelEvent): boolean {
    const predicate = this.pointerHooks?.allowPointerEvent
    if (!predicate) return true
    try {
      return predicate(event) !== false
    } catch (cause) {
      this.reportError(cause, 'pointer.allowPointerEvent')
      return false
    }
  }

  private reportError(cause: unknown, operation: string): void {
    this.events.reportError(cause, operation)
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
