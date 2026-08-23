import { GhosttyWebGpuTerminal } from '../../dist/dom/terminal.js'
import type {
  GhosttyWebGpuRendererFactory,
  GhosttyWebGpuTerminalDiagnostics,
} from '../../dist/dom/types.js'
import {
  WebGpuTerminalRenderer,
  type RendererFrameSnapshot,
  type RendererMetrics,
} from '../../dist/render/renderer.js'
import type { RenderSchedulerClock } from '../../dist/render/scheduler.js'
import type { TerminalClipboardWrite } from '../../dist/term/types.js'

type Tone = 'bad' | 'good' | 'warn'
type AdapterInfoValue = boolean | number | string
type RendererAdapterInfo = Readonly<Record<string, AdapterInfoValue>>

interface ResizeMessage {
  readonly cols: number
  readonly rows: number
  readonly type: 'resize'
}

interface Disposable {
  dispose(): void
}

interface DemoDiagnosticSnapshot {
  readonly connectionState: number | undefined
  readonly diagnostics: GhosttyWebGpuTerminalDiagnostics | undefined
  readonly metrics: Readonly<RendererMetrics> | undefined
  readonly sampledAt: number
}

interface AcceptanceTraceSnapshot {
  readonly activeElementIsTerminalTextarea: boolean
  readonly cursorBlinkEnabled: boolean
  readonly devicePixelRatio: number
  readonly diagnosticSnapshot: DemoDiagnosticSnapshot
  readonly document: {
    readonly hasFocus: boolean
    readonly visibilityState: DocumentVisibilityState
  }
  readonly navigator: {
    readonly platform: string
    readonly userAgent: string
  }
  readonly rendererAdapterInfo: RendererAdapterInfo | undefined
  readonly schedulerTrace: readonly SchedulerTraceEntry[]
  readonly timestamp: string
}

interface DemoDiagnosticApi {
  readonly terminal: GhosttyWebGpuTerminal | undefined
  clearTrace(): void
  metrics(): Readonly<RendererMetrics> | undefined
  sample(): DemoDiagnosticSnapshot
  trace(): readonly SchedulerTraceEntry[]
}

interface SchedulerTraceBase {
  readonly at: number
  readonly sequence: number
}

type SchedulerTraceEntry =
  | (SchedulerTraceBase & {
      readonly handle: number
      readonly type: 'raf-cancel' | 'raf-request' | 'raf-run'
    })
  | (SchedulerTraceBase & {
      readonly delayMs?: number
      readonly handle: number
      readonly type: 'timer-clear' | 'timer-fire' | 'timer-set'
    })
  | (SchedulerTraceBase & {
      readonly submittedFrames: number
      readonly type: 'frame-submit'
    })

type SchedulerTraceDetails =
  | Omit<Extract<SchedulerTraceEntry, { readonly type: `raf-${string}` }>, keyof SchedulerTraceBase>
  | Omit<
      Extract<SchedulerTraceEntry, { readonly type: `timer-${string}` }>,
      keyof SchedulerTraceBase
    >
  | Omit<Extract<SchedulerTraceEntry, { readonly type: 'frame-submit' }>, keyof SchedulerTraceBase>

declare global {
  interface Window {
    readonly __ghosttyDemo: DemoDiagnosticApi
  }
}

const numberFormatter = new Intl.NumberFormat('en-US')
const clipboardDecoder = new TextDecoder('utf-8')
const schedulerTraceLimit = 512
const standardAdapterInfoKeys = Object.freeze([
  'architecture',
  'description',
  'device',
  'isFallbackAdapter',
  'subgroupMaxSize',
  'subgroupMinSize',
  'vendor',
])

function requiredElement<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector)
  if (element) return element
  throw new TypeError(`Demo element is missing: ${selector}`)
}

const ui = {
  clearTrace: requiredElement<HTMLButtonElement>('#clear-trace'),
  connection: requiredElement<HTMLElement>('#connection-state'),
  cursorBlink: requiredElement<HTMLInputElement>('#cursor-blink'),
  event: requiredElement<HTMLElement>('#event-state'),
  fatal: requiredElement<HTMLElement>('#fatal'),
  fatalMessage: requiredElement<HTMLElement>('#fatal-message'),
  grid: requiredElement<HTMLElement>('#grid-state'),
  host: requiredElement<HTMLElement>('#terminal-host'),
  idle: requiredElement<HTMLElement>('#idle-state'),
  osc52: requiredElement<HTMLInputElement>('#osc52-opt-in'),
  reconnect: requiredElement<HTMLButtonElement>('#reconnect'),
  sampleIdle: requiredElement<HTMLButtonElement>('#sample-idle'),
  security: requiredElement<HTMLElement>('#security-state'),
  traffic: requiredElement<HTMLElement>('#traffic-state'),
  trace: requiredElement<HTMLPreElement>('#trace-state'),
}

let bytesFromPty = 0
let bytesToPty = 0
let demoToken: string | undefined
let disposed = false
let incoming = Promise.resolve()
let lastResize: ResizeMessage | undefined
let socket: WebSocket | undefined
let socketGeneration = 0
let terminal: GhosttyWebGpuTerminal | undefined
let terminalRenderer: WebGpuTerminalRenderer | undefined
let rendererAdapterInfo: RendererAdapterInfo | undefined
let traceSequence = 0
const schedulerTrace: SchedulerTraceEntry[] = []
const subscriptions: Disposable[] = []

function setStatus(element: HTMLElement, text: string, tone: Tone): void {
  element.textContent = text
  element.dataset.tone = tone
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? cause.message
  return String(cause)
}

function showFatal(cause: unknown): void {
  setStatus(ui.connection, 'failed', 'bad')
  ui.fatalMessage.textContent = errorText(cause)
  ui.fatal.hidden = false
}

function setLastEvent(text: string, tone: Tone = 'good'): void {
  setStatus(ui.event, text, tone)
}

function assertLoopbackPage(): void {
  if (location.hostname === '127.0.0.1') return
  throw new TypeError('The terminal lab must be loaded from the loopback server at 127.0.0.1')
}

function pageToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="ghostty-demo-token"]')
  const token = meta?.content.trim() ?? ''
  if (token.length === 0 || token === '__GHOSTTY_DEMO_TOKEN__') {
    throw new TypeError('The server did not inject an authentication token')
  }
  return token
}

function websocketUrl(token: string): URL {
  const url = new URL('/pty', location.origin)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url
}

function updateSecurityStatus(): void {
  const clipboard = ui.osc52.checked ? 'OSC 52 enabled' : 'OSC 52 denied'
  setStatus(ui.security, `same-origin token · ${clipboard}`, ui.osc52.checked ? 'warn' : 'good')
}

function updateTraffic(): void {
  const incomingBytes = numberFormatter.format(bytesFromPty)
  const outgoingBytes = numberFormatter.format(bytesToPty)
  ui.traffic.textContent = `↓ ${incomingBytes} B · ↑ ${outgoingBytes} B`
}

function idleResourceNames(current: GhosttyWebGpuTerminal): readonly string[] {
  const diagnostics = current.diagnostics
  const resources: string[] = []
  if (diagnostics.hasPendingFrame) resources.push('frame')
  if (diagnostics.hasPendingTimer) resources.push('timer')
  if (diagnostics.hasPendingLinkResolution) resources.push('link')
  return resources
}

function appendSchedulerTrace(details: SchedulerTraceDetails): void {
  const entry = Object.freeze({
    at: performance.now(),
    sequence: ++traceSequence,
    ...details,
  }) as SchedulerTraceEntry
  schedulerTrace.push(entry)
  const excess = schedulerTrace.length - schedulerTraceLimit
  if (excess > 0) schedulerTrace.splice(0, excess)
}

function copiedSchedulerTrace(): readonly SchedulerTraceEntry[] {
  const entries = schedulerTrace.map((entry) => Object.freeze({ ...entry }))
  return Object.freeze(entries)
}

function clearSchedulerTrace(): void {
  schedulerTrace.length = 0
}

function tracingSchedulerClock(): RenderSchedulerClock {
  return {
    cancelFrame: (handle) => {
      window.cancelAnimationFrame(handle)
      appendSchedulerTrace({ handle, type: 'raf-cancel' })
    },
    clearTimer: (handle) => {
      window.clearTimeout(handle)
      appendSchedulerTrace({ handle, type: 'timer-clear' })
    },
    requestFrame: (callback) => {
      let handle = 0
      handle = window.requestAnimationFrame(() => {
        appendSchedulerTrace({ handle, type: 'raf-run' })
        callback()
      })
      appendSchedulerTrace({ handle, type: 'raf-request' })
      return handle
    },
    setTimer: (callback, delayMs) => {
      let handle = 0
      handle = window.setTimeout(() => {
        appendSchedulerTrace({ handle, type: 'timer-fire' })
        callback()
      }, delayMs)
      appendSchedulerTrace({ delayMs, handle, type: 'timer-set' })
      return handle
    },
  }
}

function availableAdapterInfoKeys(info: GPUAdapterInfo): readonly string[] {
  const keys = new Set([...standardAdapterInfoKeys, ...Object.keys(info)])
  const prototype = Object.getPrototypeOf(info) as object | null
  if (!prototype) return [...keys].sort()
  for (const key of Object.getOwnPropertyNames(prototype)) keys.add(key)
  keys.delete('constructor')
  return [...keys].sort()
}

function adapterInfoValue(info: GPUAdapterInfo, key: string): AdapterInfoValue | undefined {
  let value: unknown
  try {
    value = Reflect.get(info, key)
  } catch {
    return undefined
  }
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  return undefined
}

function copyAdapterInfo(info: GPUAdapterInfo): RendererAdapterInfo {
  const copied: Record<string, AdapterInfoValue> = {}
  for (const key of availableAdapterInfoKeys(info)) {
    const value = adapterInfoValue(info, key)
    if (value === undefined) continue
    copied[key] = value
  }
  return Object.freeze(copied)
}

async function createRendererDevice(): Promise<GPUDevice> {
  const gpu = navigator.gpu
  if (!gpu) throw new TypeError('WebGPU is unavailable: navigator.gpu is missing')
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new TypeError('WebGPU could not provide a high-performance adapter')
  const device = await adapter.requestDevice()
  rendererAdapterInfo = copyAdapterInfo(adapter.info)
  return device
}

function rendererMetrics(): Readonly<RendererMetrics> | undefined {
  const metrics = terminalRenderer?.metrics
  if (!metrics) return undefined
  return Object.freeze({ ...metrics })
}

function diagnosticSnapshot(): DemoDiagnosticSnapshot {
  return Object.freeze({
    connectionState: socket?.readyState,
    diagnostics: terminal?.diagnostics,
    metrics: rendererMetrics(),
    sampledAt: performance.now(),
  })
}

function acceptanceTraceSnapshot(): AcceptanceTraceSnapshot {
  const textarea = terminal?.textarea
  return Object.freeze({
    activeElementIsTerminalTextarea: textarea !== undefined && document.activeElement === textarea,
    cursorBlinkEnabled: ui.cursorBlink.checked,
    devicePixelRatio: window.devicePixelRatio,
    diagnosticSnapshot: diagnosticSnapshot(),
    document: Object.freeze({
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    }),
    navigator: Object.freeze({
      platform: navigator.platform,
      userAgent: navigator.userAgent,
    }),
    rendererAdapterInfo,
    schedulerTrace: copiedSchedulerTrace(),
    timestamp: new Date().toISOString(),
  })
}

function renderAcceptanceTrace(): void {
  ui.trace.textContent = JSON.stringify(acceptanceTraceSnapshot(), undefined, 2)
}

function updateIdleStatus(): void {
  const current = terminal
  if (!current || current.lifecycle !== 'open') {
    setStatus(ui.idle, 'terminal unavailable', 'bad')
    return
  }
  const resources = idleResourceNames(current)
  const submitted = numberFormatter.format(terminalRenderer?.metrics.submittedFrames ?? 0)
  if (resources.length === 0) {
    setStatus(ui.idle, `quiescent · ${submitted} frames`, 'good')
    return
  }
  setStatus(ui.idle, `${resources.join(' + ')} · ${submitted} frames`, 'warn')
}

function sampleIdle(): void {
  updateIdleStatus()
  renderAcceptanceTrace()
}

function clearTraceAndRefresh(): void {
  clearSchedulerTrace()
  renderAcceptanceTrace()
}

function preventControlFocus(event: MouseEvent): void {
  event.preventDefault()
}

function preserveTerminalFocus(button: HTMLButtonElement): void {
  button.addEventListener('mousedown', preventControlFocus)
}

function clipboardRepresentation(write: TerminalClipboardWrite): Uint8Array | undefined {
  return write.contents.find((entry) => entry.mime.toLowerCase().startsWith('text/plain'))?.data
}

function clipboardWrite(write: TerminalClipboardWrite) {
  if (!ui.osc52.checked) {
    setLastEvent('OSC 52 write denied', 'warn')
    return 'denied' as const
  }
  const bytes = clipboardRepresentation(write)
  if (!bytes) {
    setLastEvent('OSC 52 write unsupported', 'bad')
    return 'unsupported' as const
  }
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    setLastEvent('OSC 52 browser clipboard unavailable', 'bad')
    return 'unsupported' as const
  }
  const text = clipboardDecoder.decode(bytes)
  try {
    const completion = navigator.clipboard.writeText(text).then(() => {
      setLastEvent('OSC 52 write completed')
    })
    setLastEvent('OSC 52 write accepted', 'warn')
    return { completion, result: 'success' as const }
  } catch {
    setLastEvent('OSC 52 write failed', 'bad')
    return 'io-error' as const
  }
}

function activateUri(uri: string): void {
  const target = new URL(uri)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TypeError(`Blocked link protocol: ${target.protocol}`)
  }
  setLastEvent(`link opened · ${target.host}`)
  window.open(target, '_blank', 'noopener,noreferrer')
}

function sendResize(target: WebSocket): void {
  if (!lastResize || target.readyState !== WebSocket.OPEN) return
  target.send(JSON.stringify(lastResize))
}

function sendInput(bytes: Uint8Array): void {
  const target = socket
  if (!target || target.readyState !== WebSocket.OPEN) {
    setStatus(ui.connection, 'offline · input dropped', 'warn')
    return
  }
  const payload = new Uint8Array(bytes.byteLength)
  payload.set(bytes)
  target.send(payload.buffer)
  bytesToPty += bytes.byteLength
  updateTraffic()
}

function writePtyBytes(bytes: Uint8Array): void {
  const current = terminal
  if (!current || current.lifecycle !== 'open') return
  current.write(bytes)
  bytesFromPty += bytes.byteLength
  updateTraffic()
  updateIdleStatus()
}

async function consumePtyMessage(target: WebSocket, data: unknown): Promise<void> {
  if (target !== socket) return
  if (data instanceof ArrayBuffer) {
    writePtyBytes(new Uint8Array(data))
    return
  }
  if (data instanceof Blob) {
    const bytes = new Uint8Array(await data.arrayBuffer())
    if (target === socket) writePtyBytes(bytes)
    return
  }
  throw new TypeError('PTY output must use binary WebSocket frames')
}

function protocolFailure(target: WebSocket, cause: unknown): void {
  if (target !== socket) return
  setStatus(ui.connection, 'protocol error', 'bad')
  target.close(1003, 'binary PTY frames required')
  console.error('PTY protocol error', cause)
}

function handlePtyMessage(target: WebSocket, data: unknown): void {
  incoming = incoming
    .then(() => consumePtyMessage(target, data))
    .catch((cause: unknown) => protocolFailure(target, cause))
}

function handleSocketOpen(target: WebSocket, generation: number): void {
  if (target !== socket || generation !== socketGeneration) return
  setStatus(ui.connection, 'connected', 'good')
  sendResize(target)
  terminal?.focus()
  sampleIdle()
}

function handleSocketClose(target: WebSocket, generation: number, event: CloseEvent): void {
  if (target !== socket || generation !== socketGeneration) return
  socket = undefined
  const suffix = event.reason.length > 0 ? ` · ${event.reason}` : ''
  setStatus(ui.connection, `disconnected (${event.code})${suffix}`, 'warn')
}

function closeSocket(reason: string): void {
  const target = socket
  socket = undefined
  if (!target || target.readyState >= WebSocket.CLOSING) return
  target.close(1000, reason)
}

function connect(token: string): void {
  if (disposed) return
  closeSocket('reconnecting')
  const generation = socketGeneration + 1
  socketGeneration = generation
  setStatus(ui.connection, 'connecting', 'warn')
  const target = new WebSocket(websocketUrl(token))
  target.binaryType = 'arraybuffer'
  socket = target
  target.addEventListener('open', () => handleSocketOpen(target, generation))
  target.addEventListener('message', (event) => handlePtyMessage(target, event.data))
  target.addEventListener('close', (event) => handleSocketClose(target, generation, event))
  target.addEventListener('error', () => {
    if (target === socket) setStatus(ui.connection, 'transport error', 'bad')
  })
}

const createInstrumentedRenderer: GhosttyWebGpuRendererFactory = async (options, signal) => {
  const originalOnFrame = options.onFrame
  let created: WebGpuTerminalRenderer | undefined
  let observedSubmissions = 0
  const onFrame = (snapshot: RendererFrameSnapshot): void => {
    observedSubmissions += 1
    appendSchedulerTrace({
      submittedFrames: created?.metrics.submittedFrames ?? observedSubmissions,
      type: 'frame-submit',
    })
    originalOnFrame?.(snapshot)
  }
  created = await WebGpuTerminalRenderer.create({
    ...options,
    deviceFactory: createRendererDevice,
    onFrame,
    schedulerClock: tracingSchedulerClock(),
  })
  if (signal.aborted) {
    created.dispose()
    throw new DOMException('Terminal renderer creation was cancelled', 'AbortError')
  }
  terminalRenderer = created
  signal.addEventListener(
    'abort',
    () => {
      if (terminalRenderer === created) terminalRenderer = undefined
    },
    { once: true },
  )
  return created
}

function subscribeToTerminal(current: GhosttyWebGpuTerminal): void {
  subscriptions.push(current.onData(sendInput))
  subscriptions.push(
    current.onResize(({ cols, rows }) => {
      lastResize = { type: 'resize', cols, rows }
      ui.grid.textContent = `${cols} × ${rows} · DPR ${current.appearance.grid.pixelRatio}`
      if (socket) sendResize(socket)
      updateIdleStatus()
    }),
  )
  subscriptions.push(
    current.on('title', (title) => {
      document.title =
        title.length > 0 ? `${title} · terminal lab` : 'ghostty-webgpu · terminal lab'
    }),
  )
  subscriptions.push(
    current.on('error', ({ cause, operation }) => {
      setStatus(ui.idle, `error · ${operation}`, 'bad')
      setLastEvent(`error · ${operation}`, 'bad')
      console.error(`Terminal operation failed: ${operation}`, cause)
    }),
  )
}

function updateCursorBlink(): void {
  const current = terminal
  if (!current || current.lifecycle !== 'open') return
  current.setCursor({ blink: ui.cursorBlink.checked })
  setLastEvent(ui.cursorBlink.checked ? 'cursor blink enabled' : 'cursor blink disabled', 'warn')
  sampleIdle()
}

function reconnect(): void {
  if (demoToken) {
    connect(demoToken)
    return
  }
  setStatus(ui.connection, 'token unavailable', 'bad')
}

function dispose(): void {
  if (disposed) return
  disposed = true
  closeSocket('page closed')
  for (const subscription of subscriptions.splice(0)) subscription.dispose()
  terminal?.dispose()
  terminal = undefined
  terminalRenderer = undefined
}

async function start(): Promise<void> {
  assertLoopbackPage()
  const token = pageToken()
  demoToken = token
  updateSecurityStatus()
  const current = await GhosttyWebGpuTerminal.create({
    accessibility: { label: 'Interactive PTY terminal' },
    appearance: {
      cursor: { blink: false },
      font: {
        family: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        lineHeight: 1.25,
        size: 14,
      },
      scrollbackLimit: 10_000,
    },
    clipboardWrite,
    links: { activateUri },
    padding: { bottom: 10, left: 14, right: 16, top: 12 },
    rendererFactory: createInstrumentedRenderer,
    runtime: {
      kind: 'owned',
      options: {
        bridge: new URL('/bridge.wasm', location.href),
        wasm: new URL('/ghostty-vt.wasm', location.href),
      },
    },
    scrollbar: { width: 11 },
  })
  terminal = current
  if (disposed) {
    current.dispose()
    terminal = undefined
    return
  }
  subscribeToTerminal(current)
  await current.open(ui.host)
  if (disposed) return
  const grid = current.appearance.grid
  lastResize = { type: 'resize', cols: grid.columns, rows: grid.rows }
  ui.grid.textContent = `${grid.columns} × ${grid.rows} · DPR ${grid.pixelRatio}`
  updateCursorBlink()
  connect(token)
}

const diagnosticApi: DemoDiagnosticApi = Object.freeze({
  get terminal() {
    return terminal
  },
  clearTrace: clearSchedulerTrace,
  metrics: rendererMetrics,
  sample: diagnosticSnapshot,
  trace: copiedSchedulerTrace,
})

Object.defineProperty(window, '__ghosttyDemo', {
  configurable: false,
  enumerable: false,
  value: diagnosticApi,
  writable: false,
})

ui.osc52.addEventListener('change', () => {
  updateSecurityStatus()
  setLastEvent(ui.osc52.checked ? 'OSC 52 policy enabled' : 'OSC 52 policy denied', 'warn')
})
ui.cursorBlink.addEventListener('change', updateCursorBlink)
preserveTerminalFocus(ui.sampleIdle)
preserveTerminalFocus(ui.clearTrace)
ui.sampleIdle.addEventListener('click', sampleIdle)
ui.clearTrace.addEventListener('click', clearTraceAndRefresh)
ui.reconnect.addEventListener('click', reconnect)
window.addEventListener('pagehide', dispose, { once: true })

void start().catch((cause: unknown) => {
  showFatal(cause)
  dispose()
})
