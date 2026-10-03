import { LocalTerminalExecution } from '../dom/execution-local.js'
import { calculateTerminalFittedFont } from '../dom/fit.js'
import type { GhosttyWebGpuRenderer } from '../dom/types.js'
import type { InactiveCursorStyle } from '../render/cursor.js'
import type { RenderSchedulerClock } from '../render/scheduler.js'
import { WebGpuTerminalRenderer, WebGpuUnavailableError } from '../render/renderer.js'
import { WebGlTerminalRenderer, WebGlUnavailableError } from '../render/webgl/renderer.js'
import type {
  TerminalFittedFont,
  TerminalSessionEventType,
  TerminalSessionSubscription,
} from '../term/types.js'
import type {
  WorkerInitialize,
  WorkerLayout,
  WorkerMessage,
  WorkerRequest,
  WorkerState,
  TerminalOutputMessage,
} from './protocol.js'
import { workerCommandNames } from './protocol.js'
import { serializeWorkerFailure, workerError } from './structured-errors.js'

interface WorkerScope {
  readonly fonts: FontFaceSet
  requestAnimationFrame(callback: FrameRequestCallback): number
  cancelAnimationFrame(handle: number): void
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
  close(): void
}
const scope = globalThis as unknown as WorkerScope
const operationTimeout = 15_000
const workerClock: RenderSchedulerClock = {
  requestFrame: (callback) => scope.requestAnimationFrame(callback),
  cancelFrame: (handle) => scope.cancelAnimationFrame(handle),
  setTimer: (callback, delay) => scope.setTimeout(callback, delay),
  clearTimer: (handle) => scope.clearTimeout(handle),
}

export class TerminalWorkerRuntime {
  private execution?: LocalTerminalExecution
  private renderer?: GhosttyWebGpuRenderer
  private inactiveCursorStyle?: InactiveCursorStyle
  private readonly faces: FontFace[] = []
  private readonly subscriptions: TerminalSessionSubscription[] = []
  private readonly abort = new AbortController()
  private outputPort?: MessagePort
  private output = 0
  private control = 0
  private acceptedControl = 0
  private device?: GPUDevice
  private layout?: WorkerLayout
  private disposed = false
  private chain = Promise.resolve()
  private outputWaiter?: {
    readonly sequence: number
    readonly resolve: () => void
    readonly reject: (cause: unknown) => void
  }
  private readonly onMessage = (event: MessageEvent<WorkerRequest>) => {
    const request = event.data
    if (!this.validRequest(request)) {
      this.fail(workerError('protocol', 'request', { control: this.control }))
      return
    }
    this.acceptedControl = request.control
    this.chain = this.chain
      .then(() => this.execute(request))
      .catch((cause: unknown) => this.fail(cause))
  }

  constructor(private readonly initialize: WorkerInitialize) {}

  async start(): Promise<void> {
    const port = this.initialize.port
    port.onmessageerror = () =>
      this.fail(workerError('protocol', 'messageerror', { control: this.control }))
    port.onmessage = this.onMessage
    port.start()
    try {
      await this.loadFonts()
      if (this.disposed) return
      this.execution = await LocalTerminalExecution.create({
        appearance: this.initialize.appearance,
        runtime: { kind: 'owned', options: this.initialize.assets },
      })
      if (this.disposed) {
        this.execution.dispose()
        return
      }
      this.subscribe()
      this.post({ ...this.watermarks(), type: 'reply', id: 0, state: this.state() })
    } catch (cause) {
      this.fail(cause)
    }
  }

  private async loadFonts(): Promise<void> {
    if (typeof FontFace === 'undefined' || !scope.fonts)
      throw workerError('capability', 'fonts', {
        fontFace: typeof FontFace,
        fontSet: !!scope.fonts,
      })
    if (this.initialize.faces.length === 0)
      throw workerError('capability', 'fonts', { faceCount: 0 })
    for (const source of this.initialize.faces) {
      const data =
        'url' in source.source
          ? `url(${JSON.stringify(source.source.url)})`
          : new Uint8Array(source.source.bytes).buffer
      const face = new FontFace(source.family, data, source.descriptors)
      this.faces.push(face)
      await face.load()
      if (this.disposed) return
      scope.fonts.add(face)
    }
  }

  private native(): LocalTerminalExecution {
    if (this.execution && !this.disposed) return this.execution
    throw workerError('disposed', 'native', { disposed: this.disposed })
  }

  private fit(layout: WorkerLayout): TerminalFittedFont {
    const settings = this.native().appearance.font
    if (!this.initialize.faces.some((face) => face.family === settings.family))
      throw workerError('capability', 'font.family', { faceCount: this.faces.length })
    const context = new OffscreenCanvas(1, 1).getContext('2d')
    if (!context) throw workerError('capability', 'font.measure', { context: '2d' })
    context.font = `${settings.weight} ${settings.size}px ${JSON.stringify(settings.family)}`
    const metrics = context.measureText('M')
    return calculateTerminalFittedFont(
      settings,
      {
        advanceWidth: metrics.width,
        fontAscent: metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent,
        fontDescent: metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent,
      },
      layout.pixelRatio,
    )
  }

  private applyLayout(layout: WorkerLayout): void {
    if (this.layout && layout.identity < this.layout.identity) return
    const execution = this.native()
    const initial = this.layout === undefined
    this.layout = layout
    const padding = layout.padding
    const width = layout.width - padding.left - padding.right - layout.scrollbarWidth
    const height = layout.height - padding.top - padding.bottom
    if (layout.autoFit && (width <= 0 || height <= 0)) {
      // A hidden initial host still needs submission metadata, without a native resize.
      if (initial) execution.commitLayout(this.fit(layout), padding)
      return
    }
    const font = this.fit(layout)
    const columns = layout.autoFit
      ? Math.max(1, Math.floor(width / font.cssCellWidth))
      : execution.grid.columns
    const rows = layout.autoFit
      ? Math.max(1, Math.floor(height / font.cssCellHeight))
      : execution.grid.rows
    // No await splits the font, native grid and renderer commit.
    execution.commitLayout(font, padding)
    this.renderer?.setFont(font)
    execution.resize({
      columns,
      rows,
      cellWidth: font.cssCellWidth,
      cellHeight: font.cssCellHeight,
      pixelRatio: font.pixelRatio,
    })
    this.renderer?.resize({ columns, rows })
    this.renderer?.refreshRows?.(0, rows - 1)
  }

  private async open(canvas: OffscreenCanvas, layout: WorkerLayout): Promise<void> {
    if (this.renderer) throw workerError('protocol', 'open', { opened: true })
    this.applyLayout(layout)
    const execution = this.native()
    const font = this.fit(layout)
    let device: GPUDevice | undefined
    if (this.initialize.backend !== 'webgl') {
      try {
        const adapter = await navigator.gpu?.requestAdapter()
        if (adapter) device = await adapter.requestDevice()
      } catch (cause) {
        if (this.initialize.backend === 'webgpu')
          throw workerError('capability', 'renderer.webgpu', {
            causeType: cause instanceof Error ? cause.name : typeof cause,
          })
      }
      this.device = device
      if (!device && this.initialize.backend === 'webgpu')
        throw workerError('capability', 'renderer.webgpu', { device: false })
    }
    this.native()
    const options = {
      canvas,
      columns: execution.grid.columns,
      rows: execution.grid.rows,
      font,
      schedulerClock: workerClock,
      cursorBlink: execution.appearance.cursor.blink,
      theme: execution.appearance.rendererTheme,
      needsFrameRows: () => true,
      onTextFrame: (snapshot: Parameters<LocalTerminalExecution['submit']>[0]) => {
        execution.submit(snapshot)
        const summary = execution.submittedFrame
        if (!summary || this.disposed) return
        this.post({
          ...this.watermarks(),
          type: 'frame',
          base: summary.frame - 1,
          summary,
          snapshot: execution.textFrame()!,
        })
      },
      onRowsChanged: () => {},
      onCleanUpdate: () => execution.confirmCleanUpdate(),
      onError: (cause: unknown) => this.fail(cause),
    }
    const renderer = await execution.createRenderer(
      async (input) => {
        try {
          if (device)
            return await WebGpuTerminalRenderer.create({
              ...input,
              deviceFactory: async () => device!,
            })
          return await WebGlTerminalRenderer.create(input)
        } catch (cause) {
          if (cause instanceof WebGpuUnavailableError)
            throw workerError('capability', 'renderer.webgpu', { reason: cause.reason })
          if (cause instanceof WebGlUnavailableError)
            throw workerError('capability', 'renderer.webgl', { backend: this.initialize.backend })
          throw cause
        }
      },
      options,
      this.abort.signal,
    )
    this.renderer = renderer
    this.renderer.setInactiveCursorStyle?.(this.inactiveCursorStyle)
    this.renderer.schedule()
  }

  private subscribe(): void {
    const native = this.native()
    const events: readonly TerminalSessionEventType[] = [
      'appearance',
      'bell',
      'data',
      'error',
      'renderRequest',
      'resize',
      'scroll',
      'selection',
      'title',
    ]
    for (const event of events) {
      this.subscriptions.push(
        native.on(event, (value) => {
          if (event === 'renderRequest') this.renderer?.schedule()
          if (event === 'scroll') this.renderer?.notifyScroll()
          if (event === 'selection') this.renderer?.notifySelectionChange()
          if (event === 'renderRequest') return
          this.post({
            ...this.watermarks(),
            type: 'event',
            event,
            value,
            state: this.state(),
          } as WorkerMessage)
        }),
      )
    }
  }

  private validRequest(request: WorkerRequest): boolean {
    return (
      !!request &&
      request.type === 'request' &&
      request.terminal === this.initialize.terminal &&
      request.generation === this.initialize.generation &&
      Number.isSafeInteger(request.id) &&
      request.id > 0 &&
      Number.isSafeInteger(request.control) &&
      request.control === this.acceptedControl + 1 &&
      Number.isSafeInteger(request.output) &&
      request.output >= 0 &&
      workerCommandNames.has(request.command) &&
      Array.isArray(request.args)
    )
  }

  private async execute(request: WorkerRequest): Promise<void> {
    try {
      await this.awaitOutput(request.output)
      this.control = request.control
      const beforeDispose = request.command === 'dispose' ? this.state() : undefined
      const result = await this.dispatch(request)
      this.post({
        ...this.watermarks(),
        type: 'reply',
        id: request.id,
        result,
        state: beforeDispose ?? this.state(),
      })
      if (request.command === 'dispose') {
        this.initialize.port.close()
        scope.close()
      }
    } catch (cause) {
      const state = this.state()
      if (request.command === 'open') await this.cleanup()
      this.post({
        ...this.watermarks(),
        type: 'reply',
        id: request.id,
        failure: serializeWorkerFailure(cause, request.command),
        state,
      })
      if (request.command === 'open') {
        this.initialize.port.close()
        scope.close()
      }
    }
  }

  private dispatch(request: WorkerRequest): unknown {
    const native = this.native()
    switch (request.command) {
      case 'open':
        return this.open(...request.args)
      case 'layout':
        return this.applyLayout(...request.args)
      case 'setAppearance': {
        const family = request.args[0].font?.family
        if (family && !this.initialize.faces.some((face) => face.family === family))
          throw workerError('capability', 'font.family', { faceCount: this.faces.length })
        const result = native.setAppearance(...request.args)
        if (this.layout) this.applyLayout(this.layout)
        this.renderer?.setTheme(native.appearance.rendererTheme)
        this.renderer?.setCursorBlinkEnabled(native.appearance.cursor.blink)
        return result
      }
      case 'geometry':
        return native.geometry()
      case 'measure':
        return native.measure(...request.args)
      case 'measureTexts':
        return native.measureTexts(...request.args)
      case 'writeAndReadGeometry': {
        const geometry = native.writeAndReadGeometry(...request.args)
        this.renderer?.notifyWrite()
        return geometry
      }
      case 'write': {
        const result = native.write(...request.args)
        this.renderer?.notifyWrite()
        return result
      }
      case 'writeln': {
        const result = native.writeln(...request.args)
        this.renderer?.notifyWrite()
        return result
      }
      case 'sendInput':
        return native.sendInput(...request.args)
      case 'paste':
        return native.paste(...request.args)
      case 'key':
        return native.key(...request.args)
      case 'reset':
        return native.reset()
      case 'lineCount':
        return native.lineCount()
      case 'readLines':
        return native.readLines(...request.args)
      case 'scrollToTop':
        return native.scrollToTop()
      case 'scrollToBottom':
        return native.scrollToBottom()
      case 'scrollBy':
        return native.scrollBy(...request.args)
      case 'scrollToRow':
        return native.scrollToRow(...request.args)
      case 'getSelection':
        return native.getSelection(...request.args)
      case 'selectionCoordinates':
        return native.selectionCoordinates()
      case 'clearSelection':
        return native.clearSelection()
      case 'selectAll':
        return native.selectAll()
      case 'selectRange':
        return native.selectRange(...request.args)
      case 'selectLines':
        return native.selectLines(...request.args)
      case 'frameSnapshot':
        return native.frameSnapshot()
      case 'captureViewport':
        return native.captureViewport(...request.args)
      case 'focused':
        native.focus.setFocused(...request.args)
        return this.renderer?.setFocused(...request.args)
      case 'visible':
        return this.renderer?.setDocumentVisible(...request.args)
      case 'inactiveCursor': {
        const [style] = request.args
        if (this.inactiveCursorStyle === style) return false
        this.inactiveCursorStyle = style
        this.renderer?.setInactiveCursorStyle?.(style)
        return true
      }
      case 'refresh':
        return this.renderer?.refreshRows?.(...request.args)
      case 'clearTextureAtlas':
        return this.renderer?.clearTextureAtlas?.()
      case 'attachOutput':
        return this.attachOutput(...request.args)
      case 'fence':
        return undefined
      case 'dispose':
        return this.cleanup()
    }
  }

  private attachOutput(port: MessagePort): void {
    if (this.outputPort) throw workerError('protocol', 'attachOutput', { attached: true })
    this.outputPort = port
    port.onmessageerror = () =>
      this.fail(workerError('protocol', 'output.messageerror', { output: this.output }))
    port.onmessage = ({ data }: MessageEvent<TerminalOutputMessage>) => {
      if (this.disposed) return
      if (
        data?.type !== 'output' ||
        data.terminal !== this.initialize.terminal ||
        data.generation !== this.initialize.generation ||
        data.sequence !== this.output + 1 ||
        !(data.data instanceof Uint8Array)
      ) {
        this.fail(workerError('protocol', 'output', { output: this.output }))
        return
      }
      try {
        this.output = data.sequence
        this.native().write(data.data)
        this.renderer?.notifyWrite()
        port.postMessage({ ...this.identity(), type: 'output-ack', sequence: this.output })
        if (this.outputWaiter && this.output >= this.outputWaiter.sequence)
          this.outputWaiter.resolve()
      } catch (cause) {
        this.fail(cause)
      }
    }
    port.start()
    port.postMessage({ ...this.identity(), type: 'ready' })
  }

  private async awaitOutput(sequence: number): Promise<void> {
    if (sequence <= this.output) return
    if (!this.outputPort)
      throw workerError('protocol', 'fence', { expected: sequence, output: this.output })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.outputWaiter = { sequence, resolve, reject }
        timer = setTimeout(
          () =>
            reject(workerError('timeout', 'fence', { expected: sequence, output: this.output })),
          operationTimeout,
        )
      })
    } finally {
      clearTimeout(timer)
      this.outputWaiter = undefined
    }
  }

  private state(): WorkerState {
    const execution = this.execution
    if (!execution) throw workerError('startup', 'state', { initialized: false })
    const backend = this.renderer?.backend
    return {
      appearance: execution.appearance,
      scrollbar: execution.scrollbar,
      revision: execution.revision,
      backend: backend === 'webgpu' || backend === 'webgl2' ? backend : undefined,
    }
  }
  private identity() {
    return { terminal: this.initialize.terminal, generation: this.initialize.generation }
  }
  private watermarks() {
    return { ...this.identity(), control: this.control, output: this.output }
  }
  private post(message: WorkerMessage): void {
    this.initialize.port.postMessage(message)
  }

  private async cleanup(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.outputWaiter?.reject(workerError('disposed', 'fence', { output: this.output }))
    this.outputPort?.close()
    for (const subscription of this.subscriptions) subscription.dispose()
    this.execution?.dispose()
    for (const face of this.faces) scope.fonts.delete(face)
    this.faces.length = 0
    try {
      await this.device?.queue.onSubmittedWorkDone()
    } catch {}
    this.device?.destroy()
    this.device = undefined
  }
  private fail(cause: unknown): void {
    if (this.disposed) return
    void this.cleanup().finally(() => {
      this.post({
        ...this.watermarks(),
        type: 'fatal',
        failure: serializeWorkerFailure(cause, 'worker'),
      })
      this.initialize.port.close()
      scope.close()
    })
  }
}
