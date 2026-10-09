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
import type { RendererFrameSnapshot, RendererTextFrameSnapshot } from '../render/renderer.js'
import { createCompatibleTerminalRenderer } from '../render/selector.js'
import type { InactiveCursorStyle } from '../render/cursor.js'
import { observeDisplayedFrame } from '../render/displayed-frame.js'
import { EventEmitter } from '../term/events.js'
import type { LinkProvider, LinkProviderRegistration } from '../term/links.js'
import type { TerminalSession } from '../term/session.js'
import { LocalTerminalExecution } from './execution-local.js'
import type {
  TerminalSubmittedFrame,
  TerminalSubmittedSnapshot,
  TerminalSubmittedText,
} from './submitted-frame.js'
import type { TerminalApi, TerminalResult } from './terminal-api.js'
import { WorkerTerminalExecution } from '../worker/execution.js'
import { observeWorkerLayout, workerLayout } from '../worker/layout.js'
import { TerminalWorkerError, workerError } from '../worker/structured-errors.js'
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
  TerminalRendererTheme,
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
import { fontResourcesMatch } from './font-resources.js'
import {
  createDomInputController,
  createDomInputLifecycleController,
  type DomInputController,
  type DomInputLifecycleController,
} from './input.js'
import { createDomLinkController, type DomLinkController } from './links.js'
import {
  createTerminalPointerController,
  projectPointerPosition,
  type CommittedPointerLayout,
  type TerminalPointerController,
} from './pointer.js'
import { createTerminalScrollbar, type TerminalScrollbarController } from './scrollbar.js'
import {
  createTerminalSelectionController,
  type TerminalSelectionController,
  type TerminalSelectionProjection,
} from './selection.js'
import type {
  GhosttyWebGpuRenderer,
  GhosttyWebGpuRendererFactory,
  GhosttyWebGpuTerminalAccessibilityOptions,
  GhosttyWebGpuTerminalEventMap,
  GhosttyWebGpuTerminalEventType,
  GhosttyWebGpuTerminalDiagnostics,
  GhosttyWebGpuTerminalLifecycle,
  GhosttyWebGpuTerminalFromSessionOptions,
  GhosttyWebGpuTerminalInputHooks,
  GhosttyWebGpuTerminalListener,
  GhosttyWebGpuTerminalOptions,
  GhosttyWebGpuTerminalPointerHooks,
  GhosttyWebGpuTerminalScrollbarOptions,
  GhosttyWebGpuTerminalSubscription,
  TerminalInputModes,
  TerminalInputConnection,
  TerminalGeneratedInput,
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
    open: new EventEmitter(sink('event.open')),
    appearance: new EventEmitter(sink('event.appearance')),
    bell: new EventEmitter(sink('event.bell')),
    data: new EventEmitter(sink('event.data')),
    error,
    frame: new EventEmitter(sink('event.frame')),
    resize: new EventEmitter(sink('event.resize')),
    scroll: new EventEmitter(sink('event.scroll')),
    selection: new EventEmitter(sink('event.selection')),
    title: new EventEmitter(sink('event.title')),
  }
}

function disposeHostEmitters(emitters: HostEmitters): void {
  emitters.open.dispose()
  emitters.appearance.dispose()
  emitters.bell.dispose()
  emitters.data.dispose()
  emitters.frame.dispose()
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

const defaultRendererFactory: GhosttyWebGpuRendererFactory = (options, signal) =>
  createCompatibleTerminalRenderer(options, signal)

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

function leadingCursorColumn(snapshot: RendererTextFrameSnapshot): number | undefined {
  const viewport = snapshot.cursor.viewport
  if (!viewport) return undefined
  if (!viewport.wideTail) return viewport.x
  return Math.max(0, viewport.x - 1)
}

function cssRgb(color: TerminalRendererTheme['foreground']): string {
  return `rgb(${color.r} ${color.g} ${color.b})`
}

function applyPreeditAppearance(
  element: HTMLElement,
  font: TerminalFittedFont,
  theme: TerminalRendererTheme,
): void {
  element.style.backgroundColor = cssRgb(theme.background)
  element.style.color = cssRgb(theme.foreground)
  element.style.fontFamily = font.settings.family
  element.style.fontSize = `${font.settings.size}px`
  element.style.fontWeight = `${font.settings.weight}`
  element.style.letterSpacing = `${font.settings.letterSpacing}px`
  element.style.lineHeight = `${font.cssCellHeight}px`
  element.style.minHeight = `${font.cssCellHeight}px`
  element.style.minWidth = `${font.cssCellWidth}px`
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

function physicalPadding(value: number, pixelRatio: number): number {
  const result = Math.round(value * pixelRatio)
  if (Number.isSafeInteger(result) && result >= 0) return result
  throw new RangeError('Terminal padding must map to a non-negative safe device-pixel value')
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
    current.boldWeight === settings.boldWeight &&
    current.family === settings.family &&
    current.letterSpacing === settings.letterSpacing &&
    current.lineHeight === settings.lineHeight &&
    current.size === settings.size &&
    current.weight === settings.weight
  )
}

interface TextPublication {
  readonly text: TerminalSubmittedText
  readonly summary: TerminalSubmittedFrame
  readonly submittedOutput?: boolean
}

const createFromSessionInternal = Symbol('createFromSessionInternal')

export class Terminal<Mode extends 'sync' | 'async' = 'sync'> implements TerminalApi<Mode> {
  private readonly textSubscribers = new EventEmitter<TextPublication>((cause) =>
    this.reportError(cause, 'frame.text'),
  )
  private readonly pendingText: TextPublication[] = []
  private deliveringText = false
  private accessibilitySubscription?: GhosttyWebGpuTerminalSubscription
  private publicFrameSource?: TerminalSubmittedSnapshot
  private publicFrame?: TerminalSubmittedFrame
  private accessibility?: TerminalAccessibilityController
  private readonly accessibilityOptions?: false | GhosttyWebGpuTerminalAccessibilityOptions
  private readonly autoFit: boolean
  private readonly cleanup = new CleanupStack()
  private readonly copySelection
  private elementsValue?: TerminalElements
  private readonly emitters = createHostEmitters()
  private fit?: TerminalFitController
  private fittedFont?: TerminalFittedFont
  private preeditActive = false
  private workerCanvasSize?: {
    readonly canvas: HTMLCanvasElement
    readonly width: number
    readonly height: number
  }
  private readonly fitEnvironment?: Partial<TerminalFitEnvironment>
  private extensions?: ExtensionManager
  private readonly extensionDispatch = createExtensionDispatch()
  private generation = 0
  private inputOwner?: TerminalInputConnection & { readonly handler: TerminalInputHandler }
  private input?: DomInputController
  private readonly inputHooks?: GhosttyWebGpuTerminalInputHooks
  private inputLifecycle?: DomInputLifecycleController
  private inactiveCursorStyle?: InactiveCursorStyle
  private readonly keyboard
  private lastFrame?: RendererTextFrameSnapshot
  private readonly linkActivationModifier
  private links?: DomLinkController
  private layoutCommitted = false
  private readonly padding
  private readonly pendingEvents: (() => void)[] = []
  private pointer?: TerminalPointerController
  private readonly pointerHooks?: GhosttyWebGpuTerminalPointerHooks
  private renderer?: GhosttyWebGpuRenderer
  private readonly rendererFactory: GhosttyWebGpuRendererFactory
  private readonly rendererMode: GhosttyWebGpuTerminalOptions['rendererMode']
  private scrollbar?: TerminalScrollbarController
  private readonly scrollbarOptions?: GhosttyWebGpuTerminalScrollbarOptions
  private readonly scrollbarWidthValue: number
  private selection?: TerminalSelectionController
  private stateValue: GhosttyWebGpuTerminalLifecycle = 'created'

  private constructor(
    private readonly execution: LocalTerminalExecution | WorkerTerminalExecution,
    options: GhosttyWebGpuTerminalFromSessionOptions,
  ) {
    this.cleanup.add(() => this.textSubscribers.dispose())
    this.accessibilityOptions = options.accessibility
    this.autoFit = options.autoFit !== false
    this.copySelection = options.copySelection
    this.fitEnvironment = options.fitEnvironment
    this.inputHooks = options.inputHooks
    this.keyboard = options.keyboard
    this.linkActivationModifier = options.linkActivationModifier
    this.padding = options.padding
    this.pointerHooks = options.pointerHooks
    this.rendererFactory = options.rendererFactory ?? defaultRendererFactory
    this.rendererMode = options.rendererMode
    this.scrollbarOptions = options.scrollbar
    this.scrollbarWidthValue = scrollbarWidth(options.scrollbar?.width)

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
      onError: (cause, operation) => this.emitters.error.emit({ cause, operation }),
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
  ): Terminal<'async'> {
    return new Terminal<'async'>(execution, options)
  }

  private emptyInputResult(): TerminalResult<Mode, TerminalInputResult> {
    const empty = new Uint8Array()
    return this.result(this.execution.kind === 'async' ? Promise.resolve(empty) : empty)
  }

  private result<Value>(value: Value | Promise<Value>): TerminalResult<Mode, Value> {
    return value as TerminalResult<Mode, Value>
  }

  static async create(options: GhosttyWebGpuTerminalOptions = {}): Promise<Terminal> {
    const execution = await LocalTerminalExecution.create({
      appearance: options.appearance,
      links: options.links,
      runtime: options.runtime,
    })
    try {
      return new Terminal(execution, options)
    } catch (cause) {
      execution.dispose()
      throw cause
    }
  }

  static [createFromSessionInternal](
    session: TerminalSession<Event>,
    options: GhosttyWebGpuTerminalFromSessionOptions = {},
  ): Terminal {
    try {
      return new Terminal(new LocalTerminalExecution(session), options)
    } catch (cause) {
      options.elements?.dispose()
      session.dispose()
      throw cause
    }
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
      pointerOwner: this.pointer?.owner ?? 'none',
      pressedButtonCount: this.pointer?.pressedButtonCount ?? 0,
      rendererBackend:
        this.execution.kind === 'async' ? this.execution.backend : this.renderer?.backend,
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
      if (this.execution.kind === 'async') this.subscribeToSession()
      const initialAppearance = this.execution.appearance
      renderer = await this.createRenderer(elements, initialAppearance)
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
      if (this.execution.kind === 'sync') this.subscribeToSession()
      this.installAccessibility(elements)
      this.installScrollbar(elements)
      this.installInput(elements)
      this.inputHooks?.inputReady?.()
      this.installFit(elements)
      this.cleanup.add(() => this.disposeCanvasControllers())
      this.installPointer(elements)
      this.installLinks(elements)
      this.replayLastFrame()
      this.stateValue = 'open'
      this.emitHostEvent('open', elements.root)
      this.flushPendingEvents()
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
    const emitter = this.emitters[type] as EventEmitter<GhosttyWebGpuTerminalEventMap[TType]>
    return emitter.subscribe(listener)
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
    return this.subscribeText((publication) => listener(publication.text))
  }

  private subscribeText(listener: (publication: TextPublication) => void) {
    this.ensureActive()
    const after = this.execution.submittedFrame?.frame ?? 0
    return this.textSubscribers.subscribe((publication) => {
      if (publication.text.frame > after) return listener(publication)
    })
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
    this.invalidateLinks()
    const geometry = this.execution.writeAndReadGeometry(data)
    if (this.stateValue !== 'open') return this.result(geometry)
    this.accessibility?.notifyOutput()
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

  write(data: TerminalInputData): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    this.invalidateLinks()
    const result = this.execution.write(data)
    if (this.stateValue !== 'open') return this.result(result)
    this.accessibility?.notifyOutput()
    this.updateScrollbar()
    this.renderer?.notifyWrite()
    return this.result(result)
  }

  writeln(data: TerminalInputData): TerminalResult<Mode, TerminalMutationResult> {
    this.ensureOpen()
    this.invalidateLinks()
    const result = this.execution.writeln(data)
    if (this.stateValue !== 'open') return this.result(result)
    this.accessibility?.notifyOutput()
    this.updateScrollbar()
    this.renderer?.notifyWrite()
    return this.result(result)
  }

  sendInput(data: TerminalInputData): TerminalResult<Mode, TerminalInputResult> {
    this.ensureOpen()
    if (this.claimText('text', data)) return this.emptyInputResult()
    return this.result(this.execution.sendInput(data))
  }

  paste(data: TerminalInputData): TerminalResult<Mode, TerminalInputResult> {
    this.ensureOpen()
    if (this.claimText('paste', data)) return this.emptyInputResult()
    return this.result(this.execution.paste(data))
  }

  key(input: TerminalKeyInput): TerminalResult<Mode, TerminalInputResult> {
    this.ensureOpen()
    if (
      (this.inputOwner || this.extensionDispatch.input) &&
      this.claimInput({ type: 'key', input })
    )
      return this.emptyInputResult()
    return this.result(this.execution.key(input))
  }

  sendGeneratedInput(input: TerminalGeneratedInput): TerminalResult<Mode, TerminalInputResult> {
    this.ensureOpen()
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
    this.input?.resetTransientState()
    this.pointer?.cancel()
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
    this.pointer?.cancel()
    return this.result(this.execution.clearSelection())
  }

  selectAll(): TerminalResult<Mode, boolean> {
    this.ensureOpen()
    this.pointer?.cancel()
    const result = this.execution.selectAll()
    return this.result(
      result instanceof Promise
        ? result.then((value) => value.selectionChanged)
        : result.selectionChanged,
    )
  }

  selectRange(start: SelectionPoint, end: SelectionPoint): TerminalResult<Mode, boolean> {
    this.ensureOpen()
    this.pointer?.cancel()
    const result = this.execution.selectRange(start, end)
    return this.result(
      result instanceof Promise
        ? result.then((value) => value.selectionChanged)
        : result.selectionChanged,
    )
  }

  selectLines(startRow: number, endRow: number): TerminalResult<Mode, boolean> {
    this.ensureOpen()
    this.pointer?.cancel()
    const result = this.execution.selectLines(startRow, endRow)
    return this.result(
      result instanceof Promise
        ? result.then((value) => value.selectionChanged)
        : result.selectionChanged,
    )
  }

  focusNextLink(): Promise<boolean> {
    this.ensureOpen()
    return this.links?.focusNextLink() ?? Promise.resolve(false)
  }

  setColorScheme(colorScheme: TerminalColorScheme): TerminalResult<Mode, TerminalMutationResult> {
    return this.setAppearance({ colorScheme })
  }

  setCursor(cursor: Partial<TerminalCursorSettings>): TerminalResult<Mode, TerminalMutationResult> {
    return this.setAppearance({ cursor })
  }

  setAccessibilityEnabled(enabled: boolean): boolean {
    this.ensureActive()
    if (!enabled) return this.disableAccessibility()
    if (this.accessibility) return false
    const elements = this.elementsValue
    if (!elements) return false
    this.enableAccessibility(elements)
    return true
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
    return this.result(this.execution.setAppearance(options))
  }

  dispose(): TerminalResult<Mode, void> {
    if (this.stateValue === 'disposed' || this.stateValue === 'disposing')
      return this.result(this.execution.kind === 'async' ? this.execution.dispose() : undefined)
    this.stateValue = 'disposing'
    this.nextGeneration()
    this.pendingEvents.length = 0
    this.pendingText.length = 0
    this.inputOwner?.dispose()
    this.extensions?.dispose()
    this.cleanup.dispose((cause) => this.emitters.error.emit({ cause, operation: 'dispose' }))
    this.accessibility = undefined
    this.fit = undefined
    this.fittedFont = undefined
    this.preeditActive = false
    this.input = undefined
    this.inputLifecycle = undefined
    this.lastFrame = undefined
    this.layoutCommitted = false
    this.links = undefined
    this.pointer = undefined
    this.renderer = undefined
    this.scrollbar = undefined
    this.selection = undefined
    this.elementsValue = undefined
    this.workerCanvasSize = undefined
    this.stateValue = 'disposed'
    disposeHostEmitters(this.emitters)
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

  private async createRenderer(
    elements: TerminalElements,
    appearance: TerminalAppearance,
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
      this.execution.setFrameListener((snapshot) => this.handleFrame(snapshot))
      this.fittedFont = await this.execution.open(
        elements,
        workerLayout(elements, 1, this.scrollbarWidthValue, this.autoFit),
      )
      this.layoutCommitted = true
      return undefined
    }
    const grid = appearance.grid
    const font = fitTerminalFont(
      elements.canvas.ownerDocument,
      appearance.font,
      effectivePixelRatio(elements.canvas, this.fitEnvironment),
    )
    this.fittedFont = font
    this.execution.commitLayout(font, elements.padding)
    this.updatePreeditAppearance(font, appearance.rendererTheme)
    return this.execution.createRenderer(
      this.rendererFactory,
      {
        canvas: elements.canvas,
        columns: grid.columns,
        cursorBlink: appearance.cursor.blink,
        font,
        onError: (cause) => this.reportError(cause, 'renderer.restore'),
        onCleanUpdate: () => this.handleCleanUpdate(),
        [observeDisplayedFrame]: (snapshot) => this.handleFrame(snapshot),
        retainDisplayedText: true,
        needsFrameRows: () => Boolean(this.links?.needsFrame || this.textSubscribers.hasListeners),
        onRowsChanged: (rows) => {
          if (!this.emitters.frame.hasListeners && !this.extensionDispatch.events.frame) return
          this.emitHostEvent('frame', Object.freeze({ rows }))
        },
        replaceCanvas: elements.replaceCanvas
          ? () => this.replaceRendererCanvas(elements)
          : undefined,
        rows: grid.rows,
        rendererMode: this.rendererMode,
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
      effectivePixelRatio(elements.canvas, this.fitEnvironment),
    )
    this.fittedFont = font
    this.execution.commitLayout(font, elements.padding)
    this.updatePreeditAppearance(font, appearance.rendererTheme)
    this.renderer?.setCursorBlinkEnabled(appearance.cursor.blink)
    this.renderer?.setFont(font)
    this.renderer?.setTheme(appearance.rendererTheme)
    this.renderer?.resize({
      columns: appearance.grid.columns,
      rows: appearance.grid.rows,
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
    this.trackSubscription(this.execution.on('bell', () => this.emitHostEvent('bell', undefined)))
    this.trackSubscription(
      this.execution.on('data', ({ bytes }) => this.emitHostEvent('data', Uint8Array.from(bytes))),
    )
    this.trackSubscription(
      this.execution.on('error', (error) => {
        this.emitHostEvent('error', error)
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
      this.execution.on('title', ({ title }) => this.emitHostEvent('title', title)),
    )
  }

  private trackSubscription(subscription: TerminalSessionSubscription): void {
    this.cleanup.add(subscriptionCleanup(subscription))
  }

  private installAccessibility(elements: TerminalElements): void {
    this.cleanup.add(() => this.disableAccessibility())
    if (!this.accessibilityOptions) return
    this.enableAccessibility(elements)
  }

  private enableAccessibility(elements: TerminalElements): void {
    const accessibility = this.createAccessibility(elements)
    this.accessibility = accessibility
    const update = ({ text, summary, submittedOutput }: TextPublication) => {
      accessibility.update(
        { cursor: summary.cursor, paintedCursor: summary.paintedCursor, rows: text.rows },
        summary.scrollbar,
        submittedOutput,
      )
    }
    this.accessibilitySubscription = this.subscribeText(update)
    const current = this.textPublication()
    if (current) update(current)
  }

  private createAccessibility(elements: TerminalElements): TerminalAccessibilityController {
    const options = this.accessibilityOptions || undefined
    return createTerminalAccessibility({
      ...(options?.label === undefined ? {} : { label: options.label }),
      ...(options?.liveRegionMaxCharacters === undefined
        ? {}
        : { liveRegionMaxCharacters: options.liveRegionMaxCharacters }),
      ...(options?.liveRegionMaxEntries === undefined
        ? {}
        : { liveRegionMaxEntries: options.liveRegionMaxEntries }),
      root: elements.root,
      signal: elements.signal,
      textarea: elements.textarea,
    })
  }

  private disableAccessibility(): boolean {
    const accessibility = this.accessibility
    if (!accessibility) return false
    this.accessibility = undefined
    this.accessibilitySubscription?.dispose()
    this.accessibilitySubscription = undefined
    accessibility.dispose()
    return true
  }

  private installScrollbar(elements: TerminalElements): void {
    const options = this.scrollbarOptions
    const scrollbar = createTerminalScrollbar({
      actions: this.execution.scroll,
      clock: options?.clock,
      fadeDelayMs: options?.fadeDelayMs,
      minThumbSize: options?.minThumbSize,
      onError: (cause, operation) => this.reportError(cause, `scrollbar.${operation}`),
      root: elements.root,
      signal: elements.signal,
      snapshot: this.execution.scrollbar,
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

  private installInput(elements: TerminalElements): void {
    let input: DomInputController | undefined
    if (this.keyboard !== false) {
      const view = elements.root.ownerDocument.defaultView
      if (!view) throw createGhosttyError('input.install', 'Terminal input requires a window')
      input = createDomInputController({
        claimKey: this.claimDomKey,
        claimText: this.claimText,
        hooks: this.inputHooks,
        onError: (cause, operation) => this.reportError(cause, `input.${operation}`),
        onPreedit: (value) => this.updatePreedit(value),
        ...(this.execution.kind === 'sync'
          ? { session: this.execution.input }
          : {
              encoding: this.execution,
              selectionReadback: {
                hasSelection: () => this.execution.submittedFrame?.selection !== undefined,
                copy: () => this.copyWorkerSelection(view, elements.signal),
              },
            }),
        signal: elements.signal,
        textarea: elements.textarea,
      })
      this.input = input
      this.cleanup.add(() => input?.dispose())
    }
    const lifecycle = createDomInputLifecycleController({
      onDocumentVisible: (visible) => this.setDocumentVisible(visible),
      onError: (cause, operation) => this.reportError(cause, `input.${operation}`),
      onFocused: (focused) => this.handleFocused(focused),
      onResetTransientState: () => input?.resetTransientState(),
      session: this.execution.focus,
      signal: elements.signal,
      textarea: elements.textarea,
    })
    this.inputLifecycle = lifecycle
    this.cleanup.add(() => lifecycle.dispose())
  }

  private installFit(elements: TerminalElements): void {
    if (this.execution.kind === 'async') {
      const execution = this.execution
      let identity = 1
      const update = () => {
        const layout = workerLayout(elements, ++identity, this.scrollbarWidthValue, this.autoFit)
        void execution.layout(layout).catch((cause: unknown) => this.reportError(cause, 'layout'))
      }
      this.cleanup.add(observeWorkerLayout(elements, update))
      return
    }
    const refreshFontResources = (event: FontFaceSetLoadEvent) => {
      if (!fontResourcesMatch(this.execution.appearance.font.family, event.fontfaces)) return
      this.runUiOperation('appearance.font-resources', () => {
        if (this.autoFit) this.fit?.requestFit()
        if (!this.autoFit) this.measureFixedFont(this.execution.appearance.font)
        this.renderer?.clearTextureAtlas?.()
      })
    }
    const fonts = elements.root.ownerDocument.fonts
    fonts.addEventListener('loadingdone', refreshFontResources, { signal: elements.signal })
    fonts.addEventListener('loadingerror', refreshFontResources, { signal: elements.signal })
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
      onFit: (result) => this.applyFit(result),
      padding: this.padding,
      paddingElement: elements.canvas,
      signal: elements.signal,
    })
    this.fit = fit
    this.cleanup.add(() => fit.dispose())
  }

  private copyWorkerSelection(view: Window, signal: AbortSignal): Promise<void> {
    if (this.execution.kind !== 'async') return Promise.resolve()
    const text = this.execution.selectionSnapshot().then((snapshot) => snapshot.selection?.text)
    const copy = this.copySelection
    if (!copy) return writeUserSelectionToClipboard(view, text, { signal })
    return text.then((value) => {
      signal.throwIfAborted()
      if (value !== undefined) return copy(value)
    })
  }

  private refreshSelectionProjection(
    previous: TerminalSelectionProjection,
  ): TerminalSelectionProjection | undefined {
    const layout = this.committedPointerLayout()
    if (!layout || !previous.client) return undefined
    return projectPointerPosition(
      { clientX: previous.client.x, clientY: previous.client.y },
      layout,
    ).selection
  }

  private installPointer(elements: TerminalElements): void {
    const selection = createTerminalSelectionController({
      getIdentity:
        this.execution.kind === 'async' ? () => this.execution.selectionIdentity : undefined,
      getProjection: (previous) => this.refreshSelectionProjection(previous),
      onError: (cause, operation) => this.reportError(cause, operation),
      session: this.execution.selectionGesture,
      view: owningWindow(elements.canvas),
    })
    let pointer: TerminalPointerController
    try {
      pointer = createTerminalPointerController({
        canvas: elements.canvas,
        getLayout: () => this.committedPointerLayout(),
        onError: (cause, operation) => this.reportError(cause, operation),
        selection,
        session: this.execution.pointer,
        signal: elements.signal,
      })
    } catch (cause) {
      selection.dispose()
      throw cause
    }
    this.selection = selection
    this.pointer = pointer
  }

  private installLinks(elements: TerminalElements): void {
    const links = createDomLinkController({
      getFrame: () => (this.execution.linkProjection ? this.readFrame() : undefined),
      getProjection: () => this.execution.linkProjection,
      activationModifier: this.linkActivationModifier,
      canvas: elements.canvas,
      getLayout: () => this.committedPointerLayout(),
      onError: (cause, operation) => this.reportError(cause, `link.${operation}`),
      root: elements.root,
      session: this.execution.links,
      signal: elements.signal,
    })
    this.links = links
  }

  private disposeCanvasControllers(): void {
    const links = this.links
    const pointer = this.pointer
    this.links = undefined
    this.pointer = undefined
    this.selection = undefined
    invokeCleanup(
      () => links?.dispose(),
      (cause) => this.reportError(cause, 'link.dispose'),
    )
    invokeCleanup(
      () => pointer?.dispose(),
      (cause) => this.reportError(cause, 'pointer.dispose'),
    )
  }

  private replaceRendererCanvas(elements: TerminalElements): HTMLCanvasElement {
    elements.signal.throwIfAborted()
    if (!elements.replaceCanvas) throw new Error('Terminal elements cannot replace their canvas')
    const active = elements.root.ownerDocument.activeElement
    const restoreFocus =
      active === elements.canvas ||
      (active?.classList.contains('ghostty-webgpu-link') === true && elements.root.contains(active))
    const rebind = this.pointer !== undefined || this.links !== undefined
    this.disposeCanvasControllers()
    const canvas = elements.replaceCanvas()
    if (rebind) {
      if (this.execution.kind === 'sync') {
        this.installPointer(elements)
        this.installLinks(elements)
      }
    }
    if (restoreFocus) elements.textarea.focus({ preventScroll: true })
    this.replayLastFrame()
    return canvas
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
    if (paddingChanged || scrollbarWidthChanged) this.invalidateLinks()
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
      effectivePixelRatio(canvas, this.fitEnvironment),
    )
    this.commitFixedFont(font)
  }

  private handleAppearance(appearance: TerminalAppearance): void {
    if (this.execution.kind === 'async') {
      this.emitHostEvent('appearance', appearance)
      return
    }
    const renderer = this.renderer
    if (this.autoFit) this.fit?.setFont(appearance.font)
    if (!this.autoFit) {
      this.runUiOperation('appearance.font', () => this.remeasureFixedFont(appearance.font))
    }
    renderer?.setCursorBlinkEnabled(appearance.cursor.blink)
    renderer?.setTheme(appearance.rendererTheme)
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

  private setDocumentVisible(visible: boolean): void {
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
    if (!focused) this.pointer?.cancel()
  }

  private handleRenderRequest(): void {
    this.invalidateLinks()
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

  private handleCleanUpdate(): void {
    if (this.execution.kind === 'sync') this.execution.confirmCleanUpdate()
  }

  private handleFrame(snapshot: RendererTextFrameSnapshot): void {
    if (this.stateValue !== 'open' && this.stateValue !== 'opening') return
    this.updateFrameUi(this.execution.kind === 'sync' ? this.execution.submit(snapshot) : snapshot)
    this.publishText()
    if (
      this.execution.kind === 'async' &&
      (this.emitters.frame.hasListeners || this.extensionDispatch.events.frame)
    )
      this.emitHostEvent('frame', {
        rows: this.execution.submittedFrame?.rowPatches.map((row) => row.y) ?? [],
      })
  }

  private textPublication(): TextPublication | undefined {
    const summary = this.execution.submittedFrame
    if (!summary) return undefined
    return {
      summary,
      submittedOutput: this.execution.kind === 'sync' ? undefined : this.execution.submittedOutput,
      text: Object.freeze({
        frame: summary.frame,
        rows: summary.rows,
        rowPatches: summary.rowPatches,
      }),
    }
  }

  private publishText(): void {
    if (!this.textSubscribers.hasListeners) return
    const text = this.textPublication()
    if (!text) return
    this.emitText(text)
  }

  private emitText(publication: TextPublication): void {
    if (this.stateValue === 'opening') {
      this.pendingEvents.push(() => this.emitText(publication))
      return
    }
    if (this.stateValue !== 'open') return
    this.pendingText.push(publication)
    if (this.deliveringText) return
    this.deliveringText = true
    try {
      while (this.pendingText.length > 0 && this.stateValue === 'open') {
        this.textSubscribers.emit(this.pendingText.shift()!)
      }
    } finally {
      this.deliveringText = false
      this.pendingText.length = 0
    }
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
    if (summary) this.updatePreeditAppearance(summary.font, summary.theme)
    this.runUiOperation('frame.caret', () => this.positionTextarea(snapshot))
    this.runUiOperation('frame.links', () => {
      if (this.links?.needsFrame && snapshot.rows.length > 0) this.updateLinkFrame(snapshot)
      else this.invalidateLinks()
    })
    this.runUiOperation('frame.scrollbar', () => this.scrollbar?.update(scrollbar))
  }

  private invalidateLinks(): void {
    this.links?.invalidate()
  }

  private refreshLinks(): void {
    this.invalidateLinks()
    if (!(this.links?.needsFrame ?? false)) return
    const snapshot = this.readFrame()
    if (!snapshot) return
    this.updateLinkFrame(snapshot)
  }

  private updateLinkFrame(snapshot: RendererTextFrameSnapshot): void {
    const links = this.links
    const layout = this.committedPointerLayout()
    if (!links || !layout) return
    links.updateFrame(snapshot)
  }

  private committedPointerLayout(): CommittedPointerLayout | undefined {
    const elements = this.elementsValue
    if (!elements || !this.layoutCommitted) return undefined
    const summary = this.execution.submittedFrame
    if (!summary) return undefined
    const grid = summary.grid
    const font = summary.font
    const ratio = font.pixelRatio
    const padding = summary.padding
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

  private positionTextarea(snapshot: RendererTextFrameSnapshot): void {
    const elements = this.elementsValue
    if (!elements) return
    if (this.stateValue !== 'open' && this.stateValue !== 'opening') return
    this.lastFrame = snapshot
    const column = leadingCursorColumn(snapshot)
    const viewport = snapshot.cursor.viewport
    if (column === undefined || !viewport) return
    const summary = this.execution.submittedFrame
    if (!summary) return
    const grid = summary.grid
    elements.positionTextarea({
      x: summary.padding.left + column * grid.cellWidth,
      y: summary.padding.top + viewport.y * grid.cellHeight,
    })
  }

  private updatePreedit(value: string): void {
    this.preeditActive = value.length > 0
    const compositionView = this.elementsValue?.compositionView
    if (!compositionView) return
    if (this.preeditActive) {
      const summary = this.execution.submittedFrame
      const appearance = this.execution.appearance
      const font = summary?.font ?? this.fittedFont
      this.updatePreeditAppearance(font, summary?.theme ?? appearance.rendererTheme)
    }
    compositionView.textContent = value
    compositionView.classList.toggle('active', this.preeditActive)
    compositionView.hidden = !this.preeditActive
  }

  private updatePreeditAppearance(
    font: TerminalFittedFont | undefined,
    theme: TerminalRendererTheme,
  ): void {
    if (!this.preeditActive || !font) return
    const compositionView = this.elementsValue?.compositionView
    if (!compositionView) return
    applyPreeditAppearance(compositionView, font, theme)
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
      if (this.stateValue === 'open') this.extensionDispatch.events[type]?.(event)
      return
    }
    if (this.stateValue !== 'opening') return
    this.pendingEvents.push(() => this.emitHostEvent(type, event))
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

export function createGhosttyWebGpuTerminalFromSession(
  session: TerminalSession<Event>,
  options: GhosttyWebGpuTerminalFromSessionOptions = {},
): Terminal {
  return Terminal[createFromSessionInternal](session, options)
}
