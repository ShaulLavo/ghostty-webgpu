import type { RendererFrameSnapshot } from '../render/renderer.js'
import type { TerminalElements } from '../dom/elements.js'
import type { TerminalInputData } from '../term/types.js'
import { AddonManager } from './addons.js'
import { EventEmitter } from './events.js'
import { TerminalOptionsStore, type TerminalOptionChange } from './options.js'
import {
  EMPTY_MARKERS,
  createBufferPlaceholder,
  createModesPlaceholder,
  createParserPlaceholder,
  createUnicodePlaceholder,
  type ModesPlaceholder,
} from './placeholders.js'
import { defaultXtermTerminalDependencies } from './runtime.js'
import { XtermWriteQueue } from './write-queue.js'
import type {
  XtermTerminalDependencies,
  XtermTerminalHost,
  XtermTerminalRuntime,
} from './runtime-types.js'
import type {
  IBufferNamespace,
  IBufferRange,
  IDecoration,
  IDecorationOptions,
  IDisposable,
  IEvent,
  ILinkProvider,
  ILocalizableStrings,
  IMarker,
  IModes,
  IParser,
  ITerminalAddon,
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  IUnicodeHandling,
} from './types.js'

type FacadeLifecycle = 'constructed' | 'disposed' | 'disposing' | 'failed' | 'open' | 'opening'

interface DeferredCompletion {
  readonly promise: Promise<void>
  reject(cause: unknown): void
  resolve(): void
}

interface FacadeEvents {
  readonly bell: EventEmitter<void>
  readonly binary: EventEmitter<string>
  readonly cursorMove: EventEmitter<void>
  readonly data: EventEmitter<string>
  readonly key: EventEmitter<{ key: string; domEvent: KeyboardEvent }>
  readonly lineFeed: EventEmitter<void>
  readonly render: EventEmitter<{ start: number; end: number }>
  readonly resize: EventEmitter<{ cols: number; rows: number }>
  readonly scroll: EventEmitter<number>
  readonly selection: EventEmitter<void>
  readonly title: EventEmitter<string>
  readonly writeParsed: EventEmitter<void>
}

const textDecoder = new TextDecoder()
const localizableStringValues: ILocalizableStrings = {
  promptLabel: 'Terminal input',
  tooMuchOutput: 'Too much output to announce, navigate to rows manually to read',
}
const allOptionKeys = [
  'cursorBlink',
  'cursorStyle',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontWeightBold',
  'letterSpacing',
  'lineHeight',
  'minimumContrastRatio',
  'scrollback',
  'theme',
] as const satisfies readonly (keyof ITerminalOptions)[]

function convertedLineFeeds(data: TerminalInputData, convertEol: boolean): TerminalInputData {
  if (!convertEol) return data
  if (typeof data === 'string') return data.replace(/\n/gu, '\r\n')
  let lineFeeds = 0
  for (const byte of data) if (byte === 0x0a) lineFeeds += 1
  if (lineFeeds === 0) return data
  const result = new Uint8Array(data.length + lineFeeds)
  let target = 0
  for (const byte of data) {
    if (byte === 0x0a) result[target++] = 0x0d
    result[target++] = byte
  }
  return result
}

function lineFeedCount(data: TerminalInputData): number {
  if (typeof data === 'string') return [...data.matchAll(/[\n\v\f]/gu)].length
  let count = 0
  for (const byte of data) if (byte === 0x0a || byte === 0x0b || byte === 0x0c) count += 1
  return count
}

function verifyIntegers(...values: number[]): void {
  if (values.every((value) => Number.isInteger(value))) return
  throw new TypeError('This API only accepts integers')
}

function createFacadeEvents(): FacadeEvents {
  return {
    bell: new EventEmitter(),
    binary: new EventEmitter(),
    cursorMove: new EventEmitter(),
    data: new EventEmitter(),
    key: new EventEmitter(),
    lineFeed: new EventEmitter(),
    render: new EventEmitter(),
    resize: new EventEmitter(),
    scroll: new EventEmitter(),
    selection: new EventEmitter(),
    title: new EventEmitter(),
    writeParsed: new EventEmitter(),
  }
}

function disposeFacadeEvents(events: FacadeEvents): void {
  events.bell.dispose()
  events.binary.dispose()
  events.cursorMove.dispose()
  events.data.dispose()
  events.key.dispose()
  events.lineFeed.dispose()
  events.render.dispose()
  events.resize.dispose()
  events.scroll.dispose()
  events.selection.dispose()
  events.title.dispose()
  events.writeParsed.dispose()
}

function cursorChanged(
  before: Readonly<{ x: number; y: number }>,
  after: Readonly<{ x: number; y: number }>,
): boolean {
  return before.x !== after.x || before.y !== after.y
}

function renderRange(
  snapshot: RendererFrameSnapshot,
  rows: number,
): { start: number; end: number } | undefined {
  if (snapshot.rows.length === 0 || rows < 1) return undefined
  const values = snapshot.rows.map((row) => Math.max(0, Math.min(rows - 1, row.y)))
  return { end: Math.max(...values), start: Math.min(...values) }
}

function abortError(): Error {
  const error = new Error('Terminal was disposed before the native runtime became ready')
  error.name = 'AbortError'
  return error
}

function deferredCompletion(): DeferredCompletion {
  let rejectPromise = (_cause: unknown): void => {}
  let resolvePromise = (): void => {}
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject
    resolvePromise = resolve
  })
  return { promise, reject: rejectPromise, resolve: resolvePromise }
}

function parentElement(value: unknown): asserts value is HTMLElement {
  if (value && typeof value === 'object' && 'ownerDocument' in value && 'append' in value) return
  throw new TypeError('Terminal.open requires a parent HTMLElement')
}

function localizableStrings(): ILocalizableStrings {
  return {
    get promptLabel() {
      return localizableStringValues.promptLabel
    },
    set promptLabel(value: string) {
      localizableStringValues.promptLabel = value
    },
    get tooMuchOutput() {
      return localizableStringValues.tooMuchOutput
    },
    set tooMuchOutput(value: string) {
      localizableStringValues.tooMuchOutput = value
    },
  }
}

function captureDisposal(failures: unknown[], dispose: () => void): void {
  try {
    dispose()
  } catch (cause) {
    failures.push(cause)
  }
}

function throwDisposalFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, 'Encountered errors while disposing of terminal')
}

export class Terminal implements IDisposable {
  static get strings(): ILocalizableStrings {
    return localizableStrings()
  }

  private readonly addons: AddonManager<Terminal>
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean
  private customWheelEventHandler?: (event: WheelEvent) => boolean
  private readonly dependencies: XtermTerminalDependencies
  private elementValue?: HTMLElement
  private elements?: TerminalElements
  private readonly events: FacadeEvents
  readonly ghosttyOpened: Promise<void>
  readonly ghosttyReady: Promise<void>
  private host?: XtermTerminalHost
  private hostPromise?: Promise<void>
  private lifecycle: FacadeLifecycle = 'constructed'
  private readonly modesPlaceholder: ModesPlaceholder
  private nativeOwnsInput = false
  private readonly opened: DeferredCompletion
  private readonly optionsStore: TerminalOptionsStore
  private readonly bufferPlaceholder: IBufferNamespace
  private readonly parserPlaceholder: IParser
  private resizing = false
  private runtime?: XtermTerminalRuntime
  private runtimeSubscription?: IDisposable
  private textareaValue?: HTMLTextAreaElement
  private readonly unicodePlaceholder: IUnicodeHandling
  private readonly writeQueue: XtermWriteQueue<XtermTerminalRuntime>

  readonly onBell: IEvent<void>
  readonly onBinary: IEvent<string>
  readonly onCursorMove: IEvent<void>
  readonly onData: IEvent<string>
  readonly onKey: IEvent<{ key: string; domEvent: KeyboardEvent }>
  readonly onLineFeed: IEvent<void>
  readonly onRender: IEvent<{ start: number; end: number }>
  readonly onResize: IEvent<{ cols: number; rows: number }>
  readonly onScroll: IEvent<number>
  readonly onSelectionChange: IEvent<void>
  readonly onTitleChange: IEvent<string>
  readonly onWriteParsed: IEvent<void>

  constructor(options: ITerminalOptions & ITerminalInitOnlyOptions = {}) {
    this.dependencies = defaultXtermTerminalDependencies
    this.optionsStore = new TerminalOptionsStore(options, (change) =>
      this.handleOptionChange(change),
    )
    this.events = createFacadeEvents()
    this.onBell = this.events.bell.event
    this.onBinary = this.events.binary.event
    this.onCursorMove = this.events.cursorMove.event
    this.onData = this.events.data.event
    this.onKey = this.events.key.event
    this.onLineFeed = this.events.lineFeed.event
    this.onRender = this.events.render.event
    this.onResize = this.events.resize.event
    this.onScroll = this.events.scroll.event
    this.onSelectionChange = this.events.selection.event
    this.onTitleChange = this.events.title.event
    this.onWriteParsed = this.events.writeParsed.event
    this.opened = deferredCompletion()
    this.ghosttyOpened = this.opened.promise
    void this.ghosttyOpened.catch(() => {})
    this.addons = new AddonManager(this)
    this.bufferPlaceholder = createBufferPlaceholder()
    this.parserPlaceholder = createParserPlaceholder()
    this.modesPlaceholder = createModesPlaceholder()
    this.unicodePlaceholder = createUnicodePlaceholder(() =>
      Boolean(this.optionsStore.values.allowProposedApi),
    )
    this.writeQueue = new XtermWriteQueue({
      consume: (runtime, data) => this.consumeWrite(runtime, data),
      onWriteParsed: () => this.events.writeParsed.emit(undefined),
    })
    this.ghosttyReady = this.initialize()
    void this.ghosttyReady.catch(() => {})
  }

  get buffer(): IBufferNamespace {
    return this.bufferPlaceholder
  }

  get cols(): number {
    return this.optionsStore.cols
  }

  get element(): HTMLElement | undefined {
    return this.elementValue
  }

  get markers(): ReadonlyArray<IMarker> {
    this.requireProposedApi()
    return EMPTY_MARKERS
  }

  get modes(): IModes {
    return this.modesPlaceholder.modes
  }

  get options(): ITerminalOptions {
    return this.optionsStore.options
  }

  set options(value: ITerminalOptions) {
    this.optionsStore.set(value)
  }

  get parser(): IParser {
    return this.parserPlaceholder
  }

  get rows(): number {
    return this.optionsStore.rows
  }

  get textarea(): HTMLTextAreaElement | undefined {
    return this.textareaValue
  }

  get unicode(): IUnicodeHandling {
    this.requireProposedApi()
    return this.unicodePlaceholder
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    if (typeof handler !== 'function')
      throw new TypeError('Custom key event handler must be a function')
    this.customKeyEventHandler = handler
  }

  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void {
    if (typeof handler !== 'function') {
      throw new TypeError('Custom wheel event handler must be a function')
    }
    this.customWheelEventHandler = handler
  }

  blur(): void {
    this.textareaValue?.blur()
  }

  clear(): void {
    this.ensureActive('clear')
    if (!this.runtime) return
    this.runtime.clear()
    this.updateModes()
  }

  clearSelection(): void {
    this.ensureActive('clearSelection')
    if (!this.elementValue) return
    const changed = this.runtime?.clearSelection() ?? false
    if (!changed) this.events.selection.emit(undefined)
  }

  clearTextureAtlas(): void {
    this.ensureActive('clearTextureAtlas')
    this.host?.clearTextureAtlas()
  }

  deregisterCharacterJoiner(_joinerId: number): void {
    this.requireProposedApi()
    throw this.plan009Error('deregisterCharacterJoiner')
  }

  dispose(): void {
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') return
    this.lifecycle = 'disposing'
    const reason = abortError()
    this.opened.reject(reason)
    this.writeQueue.abandon()
    const failures: unknown[] = []
    captureDisposal(failures, () => this.runtimeSubscription?.dispose())
    this.runtimeSubscription = undefined
    captureDisposal(failures, () => this.host?.dispose())
    this.host = undefined
    captureDisposal(failures, () => this.elements?.dispose())
    this.elements = undefined
    captureDisposal(failures, () => this.runtime?.dispose())
    this.runtime = undefined
    captureDisposal(failures, () => disposeFacadeEvents(this.events))
    captureDisposal(failures, () => this.addons.dispose())
    this.lifecycle = 'disposed'
    throwDisposalFailures(failures)
  }

  focus(): void {
    this.textareaValue?.focus({ preventScroll: true })
  }

  getSelection(): string {
    this.ensureActive('getSelection')
    return this.runtime?.getSelection() ?? ''
  }

  getSelectionPosition(): IBufferRange | undefined {
    this.ensureActive('getSelectionPosition')
    return this.runtime?.getSelectionPosition()
  }

  hasSelection(): boolean {
    this.ensureActive('hasSelection')
    return this.runtime?.hasSelection() === true
  }

  input(data: string, wasUserInput = true): void {
    this.ensureActive('input')
    if (typeof data !== 'string') throw new TypeError('Terminal input data must be a string')
    if (this.optionsStore.values.disableStdin) return
    const runtime = this.runtime
    if (!runtime) {
      this.events.data.emit(data)
      return
    }
    if (wasUserInput) this.beforeUserInput()
    runtime.input(data, wasUserInput)
  }

  loadAddon(addon: ITerminalAddon): void {
    this.addons.load(addon)
  }

  open(parent: HTMLElement): void {
    parentElement(parent)
    if (this.elementValue) return
    this.ensureActive('open')
    const elements = this.dependencies.createElements(parent)
    elements.textarea.setAttribute('aria-label', Terminal.strings.promptLabel)
    this.elements = elements
    this.elementValue = elements.root
    this.textareaValue = elements.textarea
    this.installShellHandlers(elements)
    this.writeQueue.pause()
    this.lifecycle = 'opening'
    void this.attachHost().catch((cause: unknown) => this.fail(cause, 'open'))
  }

  paste(data: string): void {
    this.ensureActive('paste')
    if (typeof data !== 'string') throw new TypeError('Terminal paste data must be a string')
    if (this.optionsStore.values.disableStdin) return
    const runtime = this.requireRuntime('paste')
    this.beforeUserInput()
    runtime.paste(data, this.optionsStore.values.ignoreBracketedPasteMode)
  }

  refresh(start: number, end: number): void {
    this.ensureActive('refresh')
    verifyIntegers(start, end)
    if (start < 0 || end < start || end >= this.rows) {
      throw new RangeError('Refresh range must be within the terminal viewport')
    }
    this.host?.refresh(start, end)
  }

  registerCharacterJoiner(_handler: (text: string) => [number, number][]): number {
    this.requireProposedApi()
    throw this.plan009Error('registerCharacterJoiner')
  }

  registerDecoration(_options: IDecorationOptions): IDecoration | undefined {
    this.requireProposedApi()
    throw this.plan009Error('registerDecoration')
  }

  registerLinkProvider(_provider: ILinkProvider): IDisposable {
    throw this.plan009Error('registerLinkProvider')
  }

  registerMarker(cursorYOffset = 0): IMarker {
    verifyIntegers(cursorYOffset)
    throw this.plan009Error('registerMarker')
  }

  reset(): void {
    this.ensureActive('reset')
    if (!this.runtime) return
    this.runtime.reset()
    this.updateModes()
  }

  resize(columns: number, rows: number): void {
    this.ensureActive('resize')
    verifyIntegers(columns, rows)
    const rowsChanged = rows !== this.rows
    if (!this.optionsStore.resize(columns, rows)) return
    this.resizing = true
    try {
      this.runtime?.resize(this.cols, this.rows)
    } finally {
      this.resizing = false
    }
    this.events.resize.emit({ cols: this.cols, rows: this.rows })
    this.finishResizeSelection(rowsChanged)
  }

  private finishResizeSelection(rowsChanged: boolean): void {
    if (!rowsChanged || !this.elementValue) return
    if (this.runtime?.clearSelection()) return
    this.events.selection.emit(undefined)
  }

  scrollLines(amount: number): void {
    verifyIntegers(amount)
    this.ensureActive('scrollLines')
    this.runtime?.scrollBy(amount)
  }

  scrollPages(pageCount: number): void {
    verifyIntegers(pageCount)
    this.ensureActive('scrollPages')
    this.runtime?.scrollBy(pageCount * (this.rows - 1))
  }

  scrollToBottom(): void {
    this.ensureActive('scrollToBottom')
    this.runtime?.scrollToBottom()
  }

  scrollToLine(line: number): void {
    verifyIntegers(line)
    this.ensureActive('scrollToLine')
    this.runtime?.scrollToLine(Math.max(0, line))
  }

  scrollToTop(): void {
    this.ensureActive('scrollToTop')
    this.runtime?.scrollToTop()
  }

  select(column: number, row: number, length: number): void {
    verifyIntegers(column, row, length)
    this.requireRuntime('select').select(column, row, length)
  }

  selectAll(): void {
    if (!this.elementValue) return
    const changed = this.requireRuntime('selectAll').selectAll()
    if (!changed) this.events.selection.emit(undefined)
  }

  selectLines(start: number, end: number): void {
    verifyIntegers(start, end)
    if (!this.elementValue) return
    const changed = this.requireRuntime('selectLines').selectLines(start, end)
    if (!changed) this.events.selection.emit(undefined)
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.ensureActive('write')
    this.writeQueue.write(data, callback)
  }

  writeln(data: string | Uint8Array, callback?: () => void): void {
    this.ensureActive('writeln')
    this.writeQueue.writeln(data, callback)
  }

  private async initialize(): Promise<void> {
    try {
      await this.initializeRuntime()
    } catch (cause) {
      this.fail(cause, 'initialize')
      throw cause
    }
  }

  private async initializeRuntime(): Promise<void> {
    const runtime = await this.dependencies.createRuntime(
      this.optionsStore.values,
      this.cols,
      this.rows,
    )
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') {
      runtime.dispose()
      throw abortError()
    }
    this.runtime = runtime
    runtime.applyOptions(this.optionsStore.values, allOptionKeys)
    runtime.resize(this.cols, this.rows)
    this.runtimeSubscription = this.subscribeRuntime(runtime)
    this.updateModes()
    this.writeQueue.bind(runtime)
    await this.attachHost()
  }

  private attachHost(): Promise<void> {
    if (this.host || this.hostPromise) return this.hostPromise ?? Promise.resolve()
    const runtime = this.runtime
    const elements = this.elements
    if (!runtime || !elements) return Promise.resolve()
    const opening = runtime.open(
      elements,
      {
        beforeUserInput: () => this.beforeUserInput(),
        customKeyEvent: (event) => this.decideCustomKeyEvent(event),
        inputReady: () => this.commitNativeInputOwnership(),
        inputDisabled: () => this.optionsStore.values.disableStdin,
        onKey: (key, domEvent) => this.events.key.emit({ domEvent, key }),
      },
      {
        customWheelEvent: (event) => this.decideCustomWheelEvent(event),
      },
      (snapshot) => this.handleFrame(snapshot),
    )
    this.host = opening.host
    const promise = opening.ready.then(() => this.commitHost(opening.host))
    this.hostPromise = promise
    return promise
  }

  private decideCustomKeyEvent(event: KeyboardEvent): boolean {
    return this.customKeyEventHandler?.(event) !== false
  }

  private decideCustomWheelEvent(event: WheelEvent): boolean {
    return this.customWheelEventHandler?.(event) !== false
  }

  private handleShellKeyEvent(event: KeyboardEvent): void {
    if (this.nativeOwnsInput) return
    this.decideCustomKeyEvent(event)
  }

  private handleShellWheelEvent(event: WheelEvent): void {
    if (this.nativeOwnsInput) return
    this.decideCustomWheelEvent(event)
  }

  private installShellHandlers(elements: TerminalElements): void {
    const listenerOptions = { signal: elements.signal }
    elements.textarea.addEventListener(
      'keydown',
      (event) => this.handleShellKeyEvent(event),
      listenerOptions,
    )
    elements.textarea.addEventListener(
      'keypress',
      (event) => this.handleShellKeyEvent(event),
      listenerOptions,
    )
    elements.textarea.addEventListener(
      'keyup',
      (event) => this.handleShellKeyEvent(event),
      listenerOptions,
    )
    elements.root.addEventListener('wheel', (event) => this.handleShellWheelEvent(event), {
      capture: true,
      passive: true,
      signal: elements.signal,
    })
  }

  private beforeUserInput(): void {
    this.writeQueue.handleUserInput()
    const runtime = this.runtime
    if (!runtime || !this.optionsStore.values.scrollOnUserInput) return
    runtime.scrollToBottom()
  }

  private commitHost(host: XtermTerminalHost): void {
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') {
      host.dispose()
      return
    }
    if (this.host !== host) {
      host.dispose()
      return
    }
    this.lifecycle = 'open'
    this.opened.resolve()
    this.writeQueue.resume()
  }

  private emitWriteEffects(
    runtime: XtermTerminalRuntime,
    data: TerminalInputData,
    before: Readonly<{ x: number; y: number }>,
  ): void {
    for (let index = 0; index < lineFeedCount(data); index += 1) {
      this.events.lineFeed.emit(undefined)
    }
    if (cursorChanged(before, runtime.cursor)) this.events.cursorMove.emit(undefined)
    this.updateModes()
  }

  private fail(cause: unknown, operation: string): void {
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') return
    this.lifecycle = 'failed'
    this.opened.reject(cause)
    try {
      this.reportError(cause, operation)
    } finally {
      this.dispose()
    }
  }

  private handleFrame(snapshot: RendererFrameSnapshot): void {
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') return
    const range = renderRange(snapshot, this.rows)
    if (!range) return
    this.events.render.emit(range)
  }

  private handleOptionChange(change: TerminalOptionChange): void {
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') return
    this.runtime?.applyOptions(change.values, change.keys)
  }

  private commitNativeInputOwnership(): void {
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') return
    this.nativeOwnsInput = true
  }

  private plan009Error(surface: string): Error {
    return new Error(`xterm ${surface} is unavailable until Plan 009`)
  }

  private consumeWrite(runtime: XtermTerminalRuntime, input: TerminalInputData): void {
    const data = convertedLineFeeds(input, this.optionsStore.values.convertEol)
    const before = runtime.cursor
    runtime.write(data)
    this.emitWriteEffects(runtime, data, before)
  }

  private reportError(cause: unknown, operation: string): void {
    if (this.optionsStore.values.logLevel === 'off') return
    const logger = this.optionsStore.values.logger
    const error = cause instanceof Error ? cause : new Error(String(cause))
    if (logger) {
      logger.error(error, { operation })
      return
    }
    console.error(`[ghostty-webgpu] ${operation}`, error)
  }

  private requireProposedApi(): void {
    if (this.optionsStore.values.allowProposedApi) return
    throw new Error('You must set the allowProposedApi option to true to use proposed API')
  }

  private requireRuntime(operation: string): XtermTerminalRuntime {
    this.ensureActive(operation)
    if (this.runtime) return this.runtime
    throw new Error(`Terminal.${operation} requires the native runtime to be ready`)
  }

  private subscribeRuntime(runtime: XtermTerminalRuntime): IDisposable {
    return runtime.subscribe({
      bell: () => this.events.bell.emit(undefined),
      data: (data) => this.events.data.emit(textDecoder.decode(data)),
      error: (cause, operation) => this.reportError(cause, operation),
      resize: (cols, rows) => this.handleRuntimeResize(cols, rows),
      scroll: (position) => this.events.scroll.emit(position),
      selection: () => this.handleRuntimeSelection(),
      title: (title) => this.events.title.emit(title),
    })
  }

  private updateModes(): void {
    if (!this.runtime) return
    this.modesPlaceholder.update(this.runtime.modes)
  }

  private handleRuntimeSelection(): void {
    if (this.resizing) return
    this.events.selection.emit(undefined)
  }

  private handleRuntimeResize(cols: number, rows: number): void {
    if (this.resizing) return
    if (!this.optionsStore.resize(cols, rows)) return
    this.events.resize.emit({ cols, rows })
  }

  private ensureActive(operation: string): void {
    if (this.lifecycle !== 'disposed' && this.lifecycle !== 'disposing') return
    throw new Error(`Terminal.${operation} called after disposal`)
  }
}

export type {
  FontWeight,
  IBuffer,
  IBufferCell,
  IBufferCellPosition,
  IBufferElementProvider,
  IBufferLine,
  IBufferNamespace,
  IBufferRange,
  IDecoration,
  IDecorationOptions,
  IDecorationOverviewRulerOptions,
  IDisposable,
  IDisposableWithEvent,
  IEvent,
  IFunctionIdentifier,
  ILink,
  ILinkDecorations,
  ILinkHandler,
  ILinkProvider,
  ILocalizableStrings,
  ILogger,
  IMarker,
  IModes,
  IOverviewRulerOptions,
  IParser,
  ITerminalAddon,
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  ITheme,
  IUnicodeHandling,
  IUnicodeVersionProvider,
  IViewportRange,
  IViewportRangePosition,
  IWindowOptions,
  IWindowsPty,
  LogLevel,
} from './types.js'
