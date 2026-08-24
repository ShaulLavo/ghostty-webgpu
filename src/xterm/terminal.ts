import type { RendererFrameSnapshot } from '../render/renderer.js'
import type { TerminalElements } from '../dom/elements.js'
import type { TerminalInputData } from '../term/types.js'
import { AddonManager } from './addons.js'
import { EventEmitter } from './events.js'
import { DeferredTargetQueue } from './operation-queue.js'
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

interface PendingWrite {
  readonly callback?: () => void
  readonly data: TerminalInputData
}

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
const lineEnding = new Uint8Array([0x0d, 0x0a])
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

function copiedInput(data: TerminalInputData): TerminalInputData {
  if (typeof data === 'string') return data.slice()
  if (data instanceof Uint8Array) return Uint8Array.from(data)
  throw new TypeError('Terminal write data must be a string or Uint8Array')
}

function dataWithLineEnding(data: TerminalInputData): TerminalInputData {
  if (typeof data === 'string') return `${data}\r\n`
  const result = new Uint8Array(data.length + lineEnding.length)
  result.set(data)
  result.set(lineEnding, data.length)
  return result
}

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
  if (typeof data === 'string') return [...data.matchAll(/\n/gu)].length
  let count = 0
  for (const byte of data) if (byte === 0x0a) count += 1
  return count
}

function verifyIntegers(...values: number[]): void {
  if (values.every((value) => Number.isInteger(value))) return
  throw new TypeError('This API only accepts integers')
}

function createFacadeEvents(onError: (cause: unknown) => void): FacadeEvents {
  return {
    bell: new EventEmitter(onError),
    binary: new EventEmitter(onError),
    cursorMove: new EventEmitter(onError),
    data: new EventEmitter(onError),
    key: new EventEmitter(onError),
    lineFeed: new EventEmitter(onError),
    render: new EventEmitter(onError),
    resize: new EventEmitter(onError),
    scroll: new EventEmitter(onError),
    selection: new EventEmitter(onError),
    title: new EventEmitter(onError),
    writeParsed: new EventEmitter(onError),
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

export class Terminal implements IDisposable {
  static strings: ILocalizableStrings = {
    promptLabel: 'Terminal input',
    tooMuchOutput: 'Too much output to announce, navigate to rows manually to read',
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
  private readonly keyDecisions = new WeakMap<Event, boolean>()
  private lifecycle: FacadeLifecycle = 'constructed'
  private readonly modesPlaceholder: ModesPlaceholder
  private readonly operationQueue: DeferredTargetQueue<XtermTerminalRuntime>
  private readonly opened: DeferredCompletion
  private readonly optionsStore: TerminalOptionsStore
  private readonly pendingWrites: PendingWrite[] = []
  private readonly bufferPlaceholder: IBufferNamespace
  private readonly parserPlaceholder: IParser
  private runtime?: XtermTerminalRuntime
  private runtimeSubscription?: IDisposable
  private textareaValue?: HTMLTextAreaElement
  private readonly unicodePlaceholder: IUnicodeHandling
  private readonly wheelDecisions = new WeakMap<Event, boolean>()
  private writeFlushScheduled = false
  private writeParsedScheduled = false

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
    this.events = createFacadeEvents((cause) => this.reportError(cause, 'event.listener'))
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
    this.operationQueue = new DeferredTargetQueue((cause) => this.reportError(cause, 'write'))
    this.opened = deferredCompletion()
    this.ghosttyOpened = this.opened.promise
    void this.ghosttyOpened.catch(() => {})
    this.addons = new AddonManager(this, (cause, operation) =>
      this.reportError(cause, `addon.${operation}`),
    )
    this.bufferPlaceholder = createBufferPlaceholder()
    this.parserPlaceholder = createParserPlaceholder()
    this.modesPlaceholder = createModesPlaceholder()
    this.unicodePlaceholder = createUnicodePlaceholder(() =>
      Boolean(this.optionsStore.values.allowProposedApi),
    )
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
    this.ensureActive('set options')
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
    this.ensureActive('attachCustomKeyEventHandler')
    if (typeof handler !== 'function')
      throw new TypeError('Custom key event handler must be a function')
    this.customKeyEventHandler = handler
  }

  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void {
    this.ensureActive('attachCustomWheelEventHandler')
    if (typeof handler !== 'function') {
      throw new TypeError('Custom wheel event handler must be a function')
    }
    this.customWheelEventHandler = handler
  }

  blur(): void {
    this.textareaValue?.blur()
  }

  clear(): void {
    this.requireRuntime('clear').clear()
    this.updateModes()
  }

  clearSelection(): void {
    this.ensureActive('clearSelection')
    this.runtime?.clearSelection()
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
    this.pendingWrites.length = 0
    this.operationQueue.cancel(reason)
    this.addons.dispose()
    this.runtimeSubscription?.dispose()
    this.runtimeSubscription = undefined
    this.host?.dispose()
    this.host = undefined
    this.elements?.dispose()
    this.elements = undefined
    this.runtime?.dispose()
    this.runtime = undefined
    disposeFacadeEvents(this.events)
    this.lifecycle = 'disposed'
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
    this.ensureActive('loadAddon')
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
    this.requireRuntime('reset').reset()
    this.updateModes()
  }

  resize(columns: number, rows: number): void {
    this.ensureActive('resize')
    verifyIntegers(columns, rows)
    if (!this.optionsStore.resize(columns, rows)) return
    this.runtime?.resize(this.cols, this.rows)
    this.events.resize.emit({ cols: this.cols, rows: this.rows })
  }

  scrollLines(amount: number): void {
    verifyIntegers(amount)
    this.requireRuntime('scrollLines').scrollBy(amount)
  }

  scrollPages(pageCount: number): void {
    verifyIntegers(pageCount)
    this.requireRuntime('scrollPages').scrollBy(pageCount * (this.rows - 1))
  }

  scrollToBottom(): void {
    this.requireRuntime('scrollToBottom').scrollToBottom()
  }

  scrollToLine(line: number): void {
    verifyIntegers(line)
    this.requireRuntime('scrollToLine').scrollToLine(line)
  }

  scrollToTop(): void {
    this.requireRuntime('scrollToTop').scrollToTop()
  }

  select(column: number, row: number, length: number): void {
    verifyIntegers(column, row, length)
    this.requireRuntime('select').select(column, row, length)
  }

  selectAll(): void {
    this.requireRuntime('selectAll').selectAll()
  }

  selectLines(start: number, end: number): void {
    verifyIntegers(start, end)
    this.requireRuntime('selectLines').selectLines(start, end)
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.enqueueWrite(data, callback)
  }

  writeln(data: string | Uint8Array, callback?: () => void): void {
    this.enqueueWrite(dataWithLineEnding(copiedInput(data)), callback)
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
    this.operationQueue.bind(runtime)
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
    const cached = this.keyDecisions.get(event)
    if (cached !== undefined) return cached
    this.keyDecisions.set(event, false)
    const allowed = this.customKeyEventHandler?.(event) !== false
    this.keyDecisions.set(event, allowed)
    return allowed
  }

  private decideCustomWheelEvent(event: WheelEvent): boolean {
    const cached = this.wheelDecisions.get(event)
    if (cached !== undefined) return cached
    this.wheelDecisions.set(event, false)
    const allowed = this.customWheelEventHandler?.(event) !== false
    this.wheelDecisions.set(event, allowed)
    return allowed
  }

  private installShellHandlers(elements: TerminalElements): void {
    const listenerOptions = { signal: elements.signal }
    elements.textarea.addEventListener(
      'keydown',
      (event) => this.decideCustomKeyEvent(event),
      listenerOptions,
    )
    elements.textarea.addEventListener(
      'keyup',
      (event) => this.decideCustomKeyEvent(event),
      listenerOptions,
    )
    elements.root.addEventListener('wheel', (event) => this.decideCustomWheelEvent(event), {
      capture: true,
      passive: true,
      signal: elements.signal,
    })
  }

  private beforeUserInput(): void {
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

  private enqueueWrite(data: TerminalInputData, callback?: () => void): void {
    this.ensureActive('write')
    if (callback !== undefined && typeof callback !== 'function') {
      throw new TypeError('Terminal write callback must be a function')
    }
    const copied = copiedInput(data)
    this.pendingWrites.push({ callback, data: copied })
    if (this.writeFlushScheduled) return
    this.writeFlushScheduled = true
    queueMicrotask(() => this.flushPendingWrites())
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

  private flushPendingWrites(): void {
    this.writeFlushScheduled = false
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') {
      this.pendingWrites.length = 0
      return
    }
    const writes = this.pendingWrites.splice(0)
    for (const write of writes) this.queueWrite(write)
  }

  private handleFrame(snapshot: RendererFrameSnapshot): void {
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') return
    const range = renderRange(snapshot, this.rows)
    if (!range) return
    this.events.render.emit(range)
  }

  private handleOptionChange(change: TerminalOptionChange): void {
    this.ensureActive('set options')
    this.runtime?.applyOptions(change.values, change.keys)
  }

  private plan009Error(surface: string): Error {
    return new Error(`xterm ${surface} is unavailable until Plan 009`)
  }

  private queueWrite(write: PendingWrite): void {
    const data = convertedLineFeeds(write.data, this.optionsStore.values.convertEol)
    this.operationQueue.enqueue((runtime) => {
      const before = runtime.cursor
      runtime.write(data)
      this.emitWriteEffects(runtime, data, before)
      try {
        write.callback?.()
      } finally {
        this.scheduleWriteParsed()
      }
    })
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

  private scheduleWriteParsed(): void {
    if (this.writeParsedScheduled) return
    this.writeParsedScheduled = true
    this.dependencies.scheduleWriteParsed(() => {
      this.writeParsedScheduled = false
      if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') return
      this.events.writeParsed.emit(undefined)
    })
  }

  private subscribeRuntime(runtime: XtermTerminalRuntime): IDisposable {
    return runtime.subscribe({
      bell: () => this.events.bell.emit(undefined),
      data: (data) => this.events.data.emit(textDecoder.decode(data)),
      error: (cause, operation) => this.reportError(cause, operation),
      resize: (cols, rows) => {
        if (!this.optionsStore.resize(cols, rows)) return
        this.events.resize.emit({ cols, rows })
      },
      scroll: (position) => this.events.scroll.emit(position),
      selection: () => this.events.selection.emit(undefined),
      title: (title) => this.events.title.emit(title),
    })
  }

  private updateModes(): void {
    if (!this.runtime) return
    this.modesPlaceholder.update(this.runtime.modes)
  }

  private ensureActive(operation: string): void {
    if (this.lifecycle !== 'disposed' && this.lifecycle !== 'disposing') return
    throw new Error(`Terminal.${operation} called after disposal`)
  }
}
