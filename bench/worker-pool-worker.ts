import { SharedWebGl } from '../.internal/worker-pool-prototype/shared-webgl.js'
import { GhosttyRuntime } from '../src/core/runtime.js'
import { calculateTerminalFittedFont } from '../src/dom/fit.js'
import { LocalTerminalExecution } from '../src/dom/execution-local.js'
import { WebGlTerminalRenderer } from '../src/render/webgl/renderer.js'
import type { RendererTextFrameSnapshot } from '../src/render/shared/types.js'
import type { GhosttyWebGpuRenderer } from '../src/dom/types.js'
import type { TerminalFittedFont, TerminalFontSettings } from '../src/term/types.js'
import type {
  WorkerPoolDelta,
  WorkerPoolFailure,
  WorkerPoolFrame,
  WorkerPoolInit,
  WorkerPoolMessage,
  WorkerPoolRequest,
} from './worker-pool-protocol.js'

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerPoolRequest>) => void) | null
  postMessage(message: WorkerPoolMessage, transfer?: Transferable[]): void
  requestAnimationFrame(callback: FrameRequestCallback): number
  cancelAnimationFrame(handle: number): void
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
  close(): void
  fonts: FontFaceSet
}

interface Session {
  readonly id: number
  readonly execution: LocalTerminalExecution
  renderer?: GhosttyWebGpuRenderer
  readonly rows: Map<number, string>
  sequence: number
  writeSequence: number
}

const scope = globalThis as unknown as WorkerScope
const workerClock = {
  requestFrame: (callback: FrameRequestCallback) => scope.requestAnimationFrame(callback),
  cancelFrame: (handle: number) => scope.cancelAnimationFrame(handle),
  setTimer: (callback: () => void, delay: number) => scope.setTimeout(callback, delay),
  clearTimer: (handle: number) => scope.clearTimeout(handle),
}
const textEncoder = new TextEncoder()
let sessions: Session[] = []
let runtime: GhosttyRuntime | undefined
let sharedGl: SharedWebGl | undefined
const surfaceCleanups: (() => void)[] = []
let initialized = false
let disposed = false
let queue = Promise.resolve()

function post(message: WorkerPoolMessage, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer)
}

function fail(cause: unknown): void {
  const message: WorkerPoolFailure = {
    type: 'failure',
    message: cause instanceof Error ? cause.message : String(cause),
  }
  post(message)
}

function fontSettings(family: string): TerminalFontSettings {
  return {
    boldWeight: 700,
    family,
    letterSpacing: 0,
    lineHeight: 1.2,
    size: 13,
    weight: 400,
  }
}

async function loadFont(init: WorkerPoolInit): Promise<TerminalFittedFont> {
  const settings = fontSettings(init.fontFamily)
  const face = new FontFace(init.fontFamily, `url(${JSON.stringify(init.fontUrl)})`)
  await face.load()
  scope.fonts.add(face)
  const context = new OffscreenCanvas(1, 1).getContext('2d')
  if (!context) throw new Error('worker font measurement context unavailable')
  context.font = `${settings.weight} ${settings.size}px ${JSON.stringify(settings.family)}`
  const metrics = context.measureText('Mg')
  return calculateTerminalFittedFont(
    settings,
    {
      advanceWidth: context.measureText('M').width,
      fontAscent: metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent,
      fontDescent: metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent,
    },
    init.pixelRatio,
  )
}

function encodeRows(session: Session, snapshot: RendererTextFrameSnapshot): ArrayBuffer {
  const changed: { readonly y: number; readonly bytes: Uint8Array }[] = []
  for (const row of snapshot.rows) {
    if (session.rows.get(row.y) === row.text) continue
    const bytes = textEncoder.encode(row.text)
    changed.push({ y: row.y, bytes })
    session.rows.set(row.y, row.text)
  }
  const headerBytes = 8 + changed.length * 12
  const payloadBytes = changed.reduce((total, row) => total + row.bytes.byteLength, 0)
  const buffer = new ArrayBuffer(headerBytes + payloadBytes)
  const view = new DataView(buffer)
  view.setUint32(0, session.sequence)
  view.setUint16(4, changed.length)
  view.setUint16(6, 0)
  const payload = new Uint8Array(buffer, headerBytes)
  let offset = 0
  changed.forEach((row, index) => {
    const header = 8 + index * 12
    view.setUint16(header, row.y)
    view.setUint16(header + 2, 0)
    view.setUint32(header + 4, offset)
    view.setUint32(header + 8, row.bytes.byteLength)
    payload.set(row.bytes, offset)
    offset += row.bytes.byteLength
  })
  return buffer
}

function publish(
  session: Session,
  snapshot: RendererTextFrameSnapshot,
  mode: WorkerPoolInit['mode'],
): void {
  if (disposed) return
  session.sequence += 1
  const postedAt = performance.now()
  if (mode === 'control') {
    const message: WorkerPoolFrame = {
      type: 'frame',
      terminal: session.id,
      sequence: session.sequence,
      postedAt,
      snapshot,
    }
    post(message)
    return
  }
  const buffer = encodeRows(session, snapshot)
  const message: WorkerPoolDelta = {
    type: 'delta',
    terminal: session.id,
    sequence: session.sequence,
    postedAt,
    buffer,
  }
  post(message, [buffer])
}

async function createSession(
  init: WorkerPoolInit,
  font: TerminalFittedFont,
  id: number,
  canvas: OffscreenCanvas,
): Promise<Session> {
  if (!runtime) throw new Error('worker runtime unavailable')
  const execution = await LocalTerminalExecution.create({
    appearance: {
      font: font.settings,
      grid: {
        columns: init.columns,
        rows: init.rows,
        cellWidth: font.cssCellWidth,
        cellHeight: font.cssCellHeight,
        pixelRatio: font.pixelRatio,
      },
    },
    runtime: { kind: 'borrowed', runtime },
  })
  execution.commitLayout(font, { top: 0, right: 0, bottom: 0, left: 0 })
  const session: Session = {
    id,
    execution,
    rows: new Map(),
    sequence: 0,
    writeSequence: 0,
  }
  const surface = sharedGl?.surface(canvas)
  if (surface) surfaceCleanups.push(surface.dispose)
  const renderer = await execution.createRenderer(
    (options) => WebGlTerminalRenderer.create(options),
    {
      canvas: surface?.canvas ?? canvas,
      columns: init.columns,
      rows: init.rows,
      font,
      schedulerClock: workerClock,
      cursorBlink: false,
      theme: execution.appearance.rendererTheme,
      needsFrameRows: () => true,
      onTextFrame: (snapshot) => {
        surface?.present()
        execution.submit(snapshot)
        publish(session, snapshot, init.mode)
      },
      onRowsChanged: () => {},
      onError: fail,
      onCleanUpdate: () => {
        execution.confirmCleanUpdate()
      },
    },
    new AbortController().signal,
  )
  session.renderer = renderer
  return session
}

async function initialize(init: WorkerPoolInit): Promise<void> {
  if (initialized) throw new Error('worker initialized twice')
  initialized = true
  if (init.mode === 'control' && !init.canvas) throw new Error('control canvas missing')
  if (init.mode === 'pool' && (!init.canvases || init.canvases.length !== init.terminalCount))
    throw new Error('pool canvases missing')
  const font = await loadFont(init)
  runtime = await GhosttyRuntime.create({ wasm: init.wasm, bridge: init.bridge })
  if (init.mode === 'pool') sharedGl = new SharedWebGl()
  const canvases = init.mode === 'control' ? [init.canvas!] : init.canvases!
  sessions = await Promise.all(canvases.map((canvas, id) => createSession(init, font, id, canvas)))
  post({ type: 'ready', terminalCount: sessions.length })
}

async function write(terminal: number, sequence: number, data: string): Promise<void> {
  const session = sessions[terminal]
  if (!session) throw new Error(`unknown terminal ${terminal}`)
  if (sequence !== session.writeSequence + 1)
    throw new Error(`write sequence ${sequence} expected ${session.writeSequence + 1}`)
  session.writeSequence = sequence
  session.execution.write(data)
  if (!session.renderer) throw new Error(`terminal ${terminal} renderer unavailable`)
  session.renderer.notifyWrite()
  post({ type: 'ack', terminal, sequence })
}

async function dispose(): Promise<void> {
  if (disposed) return
  disposed = true
  for (const session of sessions) session.execution.dispose()
  for (const cleanup of surfaceCleanups) cleanup()
  sharedGl?.dispose()
  runtime?.dispose()
  sessions = []
  post({ type: 'stopped' })
  scope.close()
}

scope.onmessage = ({ data }: MessageEvent<WorkerPoolRequest>) => {
  queue = queue
    .then(async () => {
      if (data.type === 'initialize') return initialize(data)
      if (data.type === 'write') return write(data.terminal, data.sequence, data.data)
      return dispose()
    })
    .catch(fail)
}
