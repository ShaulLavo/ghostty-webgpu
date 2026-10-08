import type { LocalTerminalExecution } from '../dom/execution-local.js'
import type { TerminalElements } from '../dom/elements.js'
import type { TerminalSubmittedFrame } from '../dom/submitted-frame.js'
import type { RendererTextFrameSnapshot } from '../render/renderer.js'
import { EventEmitter } from '../term/events.js'
import {
  createProjectedLinkSession,
  type ProjectedLinkSession,
  type LinkProjection,
} from '../term/link-snapshot.js'
import type { LinkProvider, LinkResolverOptions } from '../term/links.js'
import type {
  TerminalFittedFont,
  TerminalSessionEventType,
  TerminalSessionListener,
} from '../term/types.js'
import type {
  WorkerInitialize,
  WorkerCommands,
  WorkerCommand,
  WorkerRequest,
  WorkerMessage,
  WorkerState,
  WorkerLayout,
} from './protocol.js'
import { TerminalWorkerError, workerError } from './structured-errors.js'
import { freezeWorkerValue } from './owned.js'
import { readOpeningFont } from './opening-font.js'
import { workerOperationTimeout } from './protocol.js'

interface Pending {
  readonly operation: string
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}
export type WorkerExecutionOptions = Omit<
  WorkerInitialize,
  'type' | 'port' | 'terminal' | 'generation'
> & {
  readonly workerUrl?: string | URL
  readonly links?: LinkResolverOptions<Event>
}

/** Host mirror contains acknowledged metadata and owned submitted text, never a native session. */
export class WorkerTerminalExecution {
  readonly kind = 'async' as const
  readonly links: ProjectedLinkSession<Event>
  private readonly worker: Worker
  private readonly port: MessagePort
  private readonly pending = new Map<number, Pending>()
  private readonly emitters = new Map<TerminalSessionEventType, EventEmitter<unknown>>()
  private readonly terminal: string
  private readonly generation = 1
  private control = 0
  private output = 0
  private readonly outputControls = new Set<number>()
  private submittedOutputValue = false
  private submittedProducerOutput = 0
  private nextId = 0
  private state?: WorkerState
  private summary?: TerminalSubmittedFrame
  private projection?: RendererTextFrameSnapshot
  private disposed = false
  private disposePromise?: Promise<void>
  private failure?: TerminalWorkerError
  private frameListener?: (snapshot: RendererTextFrameSnapshot) => void

  private constructor(options: WorkerExecutionOptions) {
    if (options.backend !== 'auto' && options.backend !== 'webgpu' && options.backend !== 'webgl')
      throw workerError('capability', 'backend', {
        requestedType: typeof options.backend,
        supported: 'auto|webgpu|webgl',
      })
    if (
      typeof Worker === 'undefined' ||
      typeof MessageChannel === 'undefined' ||
      typeof OffscreenCanvas === 'undefined' ||
      typeof HTMLCanvasElement === 'undefined' ||
      !HTMLCanvasElement.prototype.transferControlToOffscreen ||
      typeof crypto === 'undefined' ||
      typeof crypto.randomUUID !== 'function'
    )
      throw workerError('capability', 'create', {
        worker: typeof Worker,
        offscreen: typeof OffscreenCanvas,
      })
    this.links = createProjectedLinkSession({
      activateUri: options.links?.activateUri,
      onError: (error) => {
        this.emitters
          .get('error')
          ?.emit({ cause: error.cause, operation: `link.${error.operation}` })
        this.observe(
          Promise.resolve().then(() => options.links?.onError?.(error)),
          'link.onError',
        )
      },
      getProjection: () => this.linkProjection,
      resolveLinkSnapshot: (request) => this.request('resolveLinkSnapshot', [request]),
      resolveLinkDiscovery: (request) => this.request('resolveLinkDiscovery', [request]),
    })
    this.terminal = crypto.randomUUID()
    try {
      this.worker = new Worker(options.workerUrl ?? new URL('./entry.js', import.meta.url), {
        type: 'module',
      })
    } catch (cause) {
      throw workerError('startup', 'worker.create', {
        causeType: cause instanceof Error ? cause.name : typeof cause,
      })
    }
    const channel = new MessageChannel()
    this.port = channel.port1
    this.port.onmessage = ({ data }: MessageEvent<WorkerMessage>) => this.receive(data)
    this.port.onmessageerror = () =>
      this.fail(workerError('protocol', 'messageerror', { control: this.control }))
    this.port.start()
    this.worker.onerror = (event) => {
      event.preventDefault()
      this.fail(workerError('startup', 'worker.error', { line: event.lineno, column: event.colno }))
    }
    this.worker.onmessageerror = () =>
      this.fail(workerError('protocol', 'worker.messageerror', { control: this.control }))
    const initialize: WorkerInitialize = {
      type: 'initialize',
      terminal: this.terminal,
      generation: this.generation,
      port: channel.port2,
      assets: options.assets,
      faces: options.faces,
      appearance: options.appearance,
      backend: options.backend,
    }
    try {
      this.worker.postMessage(initialize, [channel.port2])
    } catch {
      this.stop()
      channel.port2.close()
      throw workerError('protocol', 'initialize', { initialized: false })
    }
  }

  static async create(options: WorkerExecutionOptions): Promise<WorkerTerminalExecution> {
    const execution = new WorkerTerminalExecution(options)
    try {
      await execution.wait(0, 'startup')
      return execution
    } catch (cause) {
      execution.stop()
      throw cause
    }
  }

  get appearance() {
    return this.confirmed().appearance
  }
  get grid() {
    return this.appearance.grid
  }
  get scrollbar() {
    return this.confirmed().scrollbar
  }
  get revision() {
    return this.confirmed().revision
  }
  get submittedFrame(): TerminalSubmittedFrame | undefined {
    return this.summary
  }
  get linkProjection(): LinkProjection | undefined {
    const summary = this.summary
    if (this.disposed || this.failure || !summary) return undefined
    if (this.state && this.state.revision > summary.nativeRevision) return undefined
    return { generation: this.generation, layout: summary.layout, revision: summary.nativeRevision }
  }

  registerLinkProvider(provider: LinkProvider<Event>) {
    return this.links.registerLinkProvider(provider)
  }

  get selectionIdentity(): LocalTerminalExecution['selectionIdentity'] {
    const summary = this.summary
    if (!summary) return undefined
    return { generation: this.generation, layout: summary.layout, revision: summary.nativeRevision }
  }
  get submittedOutput(): boolean {
    return this.submittedOutputValue
  }
  get backend() {
    return this.state?.backend
  }
  get failed() {
    return !!this.failure
  }
  get hasPendingRequest() {
    return this.pending.size > 0
  }
  private confirmed(): WorkerState {
    if (this.state) return this.state
    throw workerError('startup', 'state', { initialized: false })
  }

  private wait(id: number, operation: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            workerError('timeout', operation, { id, control: this.control, output: this.output }),
          ),
        workerOperationTimeout,
      )
      this.pending.set(id, { operation, resolve, reject, timer })
    })
  }

  request<K extends WorkerCommand>(
    command: K,
    args: Parameters<WorkerCommands[K]>,
    transfer: Transferable[] = [],
  ): Promise<ReturnType<WorkerCommands[K]>> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.disposed && command !== 'dispose')
      return Promise.reject(workerError('disposed', command, { control: this.control }))
    const id = ++this.nextId
    const reply = this.wait(id, command)
    const request = {
      type: 'request',
      terminal: this.terminal,
      generation: this.generation,
      id,
      control: ++this.control,
      output: this.output,
      command,
      args,
    } as WorkerRequest
    if (command === 'write' || command === 'writeln' || command === 'writeAndReadGeometry')
      this.outputControls.add(request.control)
    try {
      this.port.postMessage(request, transfer)
    } catch {
      this.fail(workerError('protocol', command, { id, control: this.control }))
    }
    return reply as Promise<ReturnType<WorkerCommands[K]>>
  }

  private receive(message: WorkerMessage): void {
    if (message?.terminal !== this.terminal || message.generation !== this.generation) return
    if (message.type === 'fatal') {
      this.fail(new TerminalWorkerError(message.failure))
      return
    }
    if (message.type === 'frame') {
      if (this.disposed || message.summary.frame <= (this.summary?.frame ?? 0)) return
      if (message.base !== (this.summary?.frame ?? 0)) {
        this.fail(
          workerError('protocol', 'frame.base', {
            base: message.base,
            frame: this.summary?.frame ?? 0,
          }),
        )
        return
      }
      // Producer submissions advance independently of the host's requested output fence.
      this.submittedOutputValue = message.output > this.submittedProducerOutput
      this.submittedProducerOutput = message.output
      for (const control of this.outputControls) {
        if (control > message.control) break
        this.submittedOutputValue = true
        this.outputControls.delete(control)
      }
      if (this.state)
        this.state = freezeWorkerValue({ ...this.state, mouseTracking: message.mouseTracking })
      this.summary = freezeWorkerValue(message.summary)
      this.projection = freezeWorkerValue(message.snapshot)
      this.frameListener?.(this.textFrame()!)
      return
    }
    // FIFO delivery has already handled frames preceding this acknowledgement.
    let retained = false
    for (const control of this.outputControls) {
      if (control > message.control) break
      if (retained) this.outputControls.delete(control)
      retained = true
    }
    this.state = freezeWorkerValue(message.state)
    if (message.type === 'event') {
      if (!this.disposed) this.emitters.get(message.event)?.emit(message.value)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.failure) {
      const failure = new TerminalWorkerError(message.failure)
      pending.reject(failure)
      if (pending.operation === 'open') this.fail(failure)
      return
    }
    pending.resolve(freezeWorkerValue(message.result))
  }

  on<K extends TerminalSessionEventType>(type: K, listener: TerminalSessionListener<K>) {
    let emitter = this.emitters.get(type)
    if (!emitter) {
      emitter = new EventEmitter()
      this.emitters.set(type, emitter)
    }
    return emitter.subscribe(listener as (value: unknown) => unknown)
  }

  textFrame(): RendererTextFrameSnapshot | undefined {
    return this.projection
  }
  setFrameListener(listener: (snapshot: RendererTextFrameSnapshot) => void): void {
    this.frameListener = listener
  }

  open(elements: TerminalElements, layout: WorkerLayout): Promise<TerminalFittedFont> {
    const canvas = elements.canvas.transferControlToOffscreen()
    return this.request('open', [canvas, layout], [canvas]).then(readOpeningFont)
  }
  layout(layout: WorkerLayout): Promise<void> {
    return this.request('layout', [layout])
  }
  attachOutputPort(port: MessagePort): Promise<void> {
    return this.request('attachOutput', [port], [port])
  }
  fenceOutput(sequence: number): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < this.output)
      return Promise.reject(
        workerError('protocol', 'fence', { expected: sequence, output: this.output }),
      )
    this.output = sequence
    return this.request('fence', [])
  }

  geometry() {
    return this.request('geometry', [])
  }
  measure(...args: Parameters<LocalTerminalExecution['measure']>) {
    return this.request('measure', args)
  }
  measureTexts(...args: Parameters<LocalTerminalExecution['measureTexts']>) {
    return this.request('measureTexts', args)
  }
  writeAndReadGeometry(...args: Parameters<LocalTerminalExecution['writeAndReadGeometry']>) {
    return this.request('writeAndReadGeometry', args)
  }
  write(...args: Parameters<LocalTerminalExecution['write']>) {
    return this.request('write', args)
  }
  writeln(...args: Parameters<LocalTerminalExecution['writeln']>) {
    return this.request('writeln', args)
  }
  sendInput(...args: Parameters<LocalTerminalExecution['sendInput']>) {
    return this.request('sendInput', args)
  }
  paste(...args: Parameters<LocalTerminalExecution['paste']>) {
    return this.request('paste', args)
  }
  key(...args: Parameters<LocalTerminalExecution['key']>) {
    return this.request('key', args)
  }
  reset() {
    return this.request('reset', [])
  }
  lineCount() {
    return this.request('lineCount', [])
  }
  readLines(...args: Parameters<LocalTerminalExecution['readLines']>) {
    return this.request('readLines', args)
  }
  scrollToTop() {
    return this.request('scrollToTop', [])
  }
  scrollToBottom() {
    return this.request('scrollToBottom', [])
  }
  scrollBy(...args: Parameters<LocalTerminalExecution['scrollBy']>) {
    return this.request('scrollBy', args)
  }
  scrollToRow(...args: Parameters<LocalTerminalExecution['scrollToRow']>) {
    return this.request('scrollToRow', args)
  }
  getSelection(...args: Parameters<LocalTerminalExecution['getSelection']>) {
    return this.request('getSelection', args)
  }
  selectionCoordinates() {
    return this.request('selectionCoordinates', [])
  }
  clearSelection() {
    return this.request('clearSelection', [])
  }
  selectAll() {
    return this.request('selectAll', [])
  }
  selectRange(...args: Parameters<LocalTerminalExecution['selectRange']>) {
    return this.request('selectRange', args)
  }
  selectLines(...args: Parameters<LocalTerminalExecution['selectLines']>) {
    return this.request('selectLines', args)
  }
  setAppearance(...args: Parameters<LocalTerminalExecution['setAppearance']>) {
    return this.request('setAppearance', args)
  }
  frameSnapshot() {
    return this.request('frameSnapshot', [])
  }
  captureViewport(...args: Parameters<LocalTerminalExecution['captureViewport']>) {
    return this.request('captureViewport', args)
  }

  selectionSnapshot(...args: Parameters<LocalTerminalExecution['selectionSnapshot']>) {
    return this.request('selectionSnapshot', args)
  }

  readonly selectionGesture = {
    resetSelectionGesture: () => this.request('resetSelectionGesture', []),
    selectionPress: (...args: Parameters<LocalTerminalExecution['selectionPress']>) =>
      this.request('selectionPress', args),
    selectionDrag: (...args: Parameters<LocalTerminalExecution['selectionDrag']>) =>
      this.request('selectionDrag', args),
    selectionAutoscrollTick: (
      ...args: Parameters<LocalTerminalExecution['selectionAutoscrollTick']>
    ) => this.request('selectionAutoscrollTick', args),
    selectionRelease: (...args: Parameters<LocalTerminalExecution['selectionRelease']>) =>
      this.request('selectionRelease', args),
  }
  readonly pointer = {
    mouse: (input: Parameters<LocalTerminalExecution['mouse']>[0]) =>
      this.request('mouse', [input, this.selectionIdentity]),
    mouseTracking: () => this.confirmed().mouseTracking,
    resetMouseTracking: () => this.request('resetMouseTracking', []),
    scrollBy: (delta: number) => this.scrollBy(delta),
  }

  readonly focus = {
    setFocused: (focused: boolean) => this.observe(this.request('focused', [focused]), 'focus'),
  }
  readonly scroll = {
    scrollBy: (delta: number) => this.observe(this.scrollBy(delta), 'scroll'),
    scrollToRow: (row: number) => this.observe(this.scrollToRow(row), 'scroll'),
    scrollToTop: () => this.observe(this.scrollToTop(), 'scroll'),
    scrollToBottom: () => this.observe(this.scrollToBottom(), 'scroll'),
  }

  private observe(promise: Promise<unknown>, operation: string): void {
    void promise.catch((cause: unknown) => this.emitters.get('error')?.emit({ cause, operation }))
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.links.dispose()
    this.rejectPending(workerError('disposed', 'dispose', { control: this.control }))
    this.disposePromise = this.failure
      ? Promise.resolve()
      : this.request('dispose', []).finally(() => this.stop())
    return this.disposePromise
  }
  private rejectPending(cause: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(cause)
    }
    this.pending.clear()
  }
  private fail(cause: TerminalWorkerError): void {
    if (this.failure) return
    this.failure = cause
    this.rejectPending(cause)
    this.emitters.get('error')?.emit({ cause, operation: cause.operation })
    this.stop()
  }
  private stop(): void {
    this.links.dispose()
    this.worker.terminate()
    this.port.close()
    for (const emitter of this.emitters.values()) emitter.dispose()
    this.frameListener = undefined
    this.outputControls.clear()
    this.summary = undefined
    this.projection = undefined
  }
}
