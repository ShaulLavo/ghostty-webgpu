import { realpathSync } from 'node:fs'
import { delimiter, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_DEMO_HOSTNAME,
  DEFAULT_DEMO_PORT,
  PTY_PATH,
  authorizeSameOriginRequest,
  authorizeWebSocketUpgrade,
  createDemoAuthority,
  createSecurityHeaders,
  injectDemoToken,
  type DemoAuthority,
} from './authorization.js'
import { MAX_PTY_INPUT_BYTES, parseClientMessage } from './protocol.js'

const DEMO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BRIDGE_MODULE = fileURLToPath(new URL('./pty-bridge.mjs', import.meta.url))
const INITIAL_COLS = 80
const INITIAL_ROWS = 24
const MAX_BRIDGE_LINE_CHARS = 24 * 1024 * 1024

interface DemoAssets {
  readonly bridgeWasm: Blob
  readonly client: Blob
  readonly ghosttyWasm: Blob
  readonly html: string
}

interface SocketData {
  bridge?: PtyBridge
}

interface BridgeOutputMessage {
  readonly type: 'output'
  readonly data: string
}

interface BridgeErrorMessage {
  readonly type: 'error'
  readonly message: string
}

interface BridgeExitMessage {
  readonly type: 'exit'
  readonly exitCode: number | null
  readonly signal: number | null
}

type BridgeMessage = BridgeOutputMessage | BridgeErrorMessage | BridgeExitMessage
type BridgeProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>

export interface DemoServerOptions {
  readonly hostname?: string
  readonly nodeBinary?: string
  readonly port?: number
  readonly ptyCwd?: string
}

export interface DemoServer {
  readonly hostname: string
  readonly origin: string
  readonly port: number
  stop(): Promise<void>
}

export async function startDemoServer(options: DemoServerOptions = {}): Promise<DemoServer> {
  const hostname = options.hostname ?? DEFAULT_DEMO_HOSTNAME
  const port = options.port ?? DEFAULT_DEMO_PORT
  const authority = createDemoAuthority({ hostname, port })
  const assets = await loadAssets()
  const nodeBinary = resolveNodeBinary(options.nodeBinary)
  const sessions = new Set<PtyBridge>()
  const ptyCwd = options.ptyCwd ?? REPOSITORY_ROOT
  const context = { assets, authority, nodeBinary, ptyCwd, sessions }
  const server = createHttpServer(context)
  let stopped = false
  let removeShutdownHandlers = (): void => undefined

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    removeShutdownHandlers()
    disposeSessions(sessions)
    await server.stop(true)
  }
  removeShutdownHandlers = installShutdownHandlers(stop, sessions)
  return Object.freeze({ hostname, origin: authority.origin, port, stop })
}

interface ServerContext {
  readonly assets: DemoAssets
  readonly authority: DemoAuthority
  readonly nodeBinary: string
  readonly ptyCwd: string
  readonly sessions: Set<PtyBridge>
}

function createHttpServer(context: ServerContext): Bun.Server<SocketData> {
  return Bun.serve<SocketData>({
    hostname: context.authority.hostname,
    port: context.authority.port,
    fetch: (request, server) => handleRequest(request, server, context),
    websocket: createWebSocketHandler(context),
    error(cause) {
      console.error('Demo server request failed', cause)
      return response('Internal Server Error', 500, 'text/plain; charset=utf-8')
    },
  })
}

function createWebSocketHandler(context: ServerContext): Bun.WebSocketHandler<SocketData> {
  return {
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: true,
    maxPayloadLength: MAX_PTY_INPUT_BYTES + 1024,
    open(ws) {
      try {
        ws.data.bridge = createPtyBridge(ws, context)
      } catch (cause) {
        console.error('Unable to start the PTY bridge', cause)
        ws.close(1011, 'PTY unavailable')
      }
    },
    async message(ws, raw) {
      const bridge = ws.data.bridge
      if (!bridge) {
        ws.close(1011, 'PTY unavailable')
        return
      }

      try {
        const message = parseClientMessage(raw)
        if (message.type === 'input') {
          await bridge.writeInput(message.bytes)
          return
        }
        await bridge.resize(message.cols, message.rows)
      } catch (cause) {
        console.warn('Rejected PTY client message', errorMessage(cause))
        ws.close(1003, 'Invalid PTY message')
        bridge.dispose()
      }
    },
    drain(ws) {
      ws.data.bridge?.drain()
    },
    close(ws) {
      ws.data.bridge?.dispose()
      ws.data.bridge = undefined
    },
  }
}

function handleRequest(
  request: Request,
  server: Bun.Server<SocketData>,
  context: ServerContext,
): Response | undefined {
  const authorization = authorizeSameOriginRequest(request, context.authority)
  if (!authorization.ok) return authorizationResponse(authorization.status)

  const url = new URL(request.url)
  if (url.pathname === PTY_PATH) return handleUpgrade(request, server, context.authority)
  if (request.method !== 'GET')
    return response('Method Not Allowed', 405, 'text/plain; charset=utf-8')
  if (url.search.length > 0) return response('Not Found', 404, 'text/plain; charset=utf-8')
  return serveAsset(url.pathname, context.assets, context.authority)
}

function handleUpgrade(
  request: Request,
  server: Bun.Server<SocketData>,
  authority: DemoAuthority,
): Response | undefined {
  const authorization = authorizeWebSocketUpgrade(request, authority)
  if (!authorization.ok) return authorizationResponse(authorization.status)
  if (server.upgrade(request, { data: {} })) return undefined
  return response('WebSocket Upgrade Failed', 500, 'text/plain; charset=utf-8')
}

function serveAsset(pathname: string, assets: DemoAssets, authority: DemoAuthority): Response {
  if (pathname === '/') {
    const html = injectDemoToken(assets.html, authority.token)
    return response(html, 200, 'text/html; charset=utf-8')
  }
  if (pathname === '/client.js') {
    return response(assets.client, 200, 'text/javascript; charset=utf-8')
  }
  if (pathname === '/ghostty-vt.wasm') {
    return response(assets.ghosttyWasm, 200, 'application/wasm')
  }
  if (pathname === '/bridge.wasm') {
    return response(assets.bridgeWasm, 200, 'application/wasm')
  }
  return response('Not Found', 404, 'text/plain; charset=utf-8')
}

function authorizationResponse(status: 400 | 403 | 405): Response {
  if (status === 405) return response('Method Not Allowed', status, 'text/plain; charset=utf-8')
  if (status === 400) return response('Bad Request', status, 'text/plain; charset=utf-8')
  return response('Forbidden', status, 'text/plain; charset=utf-8')
}

function response(body: BodyInit | null, status: number, contentType: string): Response {
  return new Response(body, { status, headers: createSecurityHeaders(contentType) })
}

async function loadAssets(): Promise<DemoAssets> {
  const [html, client, ghosttyWasm, bridgeWasm] = await Promise.all([
    readTextAsset(join(DEMO_ROOT, 'index.html')),
    buildClient(),
    readBlobAsset(join(REPOSITORY_ROOT, 'ghostty-vt.wasm')),
    readBlobAsset(join(REPOSITORY_ROOT, 'bridge.wasm')),
  ])
  return { bridgeWasm, client, ghosttyWasm, html }
}

async function buildClient(): Promise<Blob> {
  const result = await Bun.build({
    entrypoints: [join(DEMO_ROOT, 'src', 'client.ts')],
    format: 'esm',
    target: 'browser',
  })
  if (!result.success) {
    const details = result.logs.map((message) => message.message).join('\n')
    throw new TypeError(
      `Unable to build the demo client${details.length > 0 ? `:\n${details}` : ''}`,
    )
  }

  const output = result.outputs.find((artifact) => artifact.kind === 'entry-point')
  if (output) return output
  throw new TypeError('The demo client build produced no entry point')
}

async function readTextAsset(path: string): Promise<string> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new TypeError(`Required demo asset is missing: ${path}`)
  return file.text()
}

async function readBlobAsset(path: string): Promise<Blob> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new TypeError(`Required demo asset is missing: ${path}`)
  return file
}

function createPtyBridge(
  socket: Bun.ServerWebSocket<SocketData>,
  context: ServerContext,
): PtyBridge {
  const config = Buffer.from(
    JSON.stringify({ cols: INITIAL_COLS, rows: INITIAL_ROWS, cwd: context.ptyCwd }),
  ).toString('base64url')
  const child = Bun.spawn({
    cmd: [context.nodeBinary, BRIDGE_MODULE, config],
    cwd: DEMO_ROOT,
    env: process.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const bridge = new PtyBridge(child, socket, () => context.sessions.delete(bridge))
  context.sessions.add(bridge)
  return bridge
}

class PtyBridge {
  readonly #child: BridgeProcess
  readonly #socket: Bun.ServerWebSocket<SocketData>
  readonly #onDispose: () => void
  #disposed = false
  #drainPromise: Promise<void> | undefined
  #resolveDrain: (() => void) | undefined
  #writeTail: Promise<void> = Promise.resolve()

  constructor(
    child: BridgeProcess,
    socket: Bun.ServerWebSocket<SocketData>,
    onDispose: () => void,
  ) {
    this.#child = child
    this.#socket = socket
    this.#onDispose = onDispose
    void this.#readOutput()
    void this.#readErrors()
    void child.exited.then(() => this.#handleChildExit())
  }

  writeInput(bytes: Uint8Array): Promise<void> {
    return this.#queueCommand({ type: 'input', data: Buffer.from(bytes).toString('base64') })
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.#queueCommand({ type: 'resize', cols, rows })
  }

  drain(): void {
    const resolve = this.#resolveDrain
    this.#resolveDrain = undefined
    this.#drainPromise = undefined
    resolve?.()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.drain()
    this.#onDispose()
    try {
      this.#child.stdin.write('{"type":"close"}\n')
      this.#child.stdin.end()
    } catch {
      // A sidecar exit may close its pipe before the WebSocket close callback.
    }
    if (!this.#child.killed && this.#child.exitCode === null) this.#child.kill('SIGTERM')
  }

  #queueCommand(command: object): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    const pending = this.#writeTail.then(() => this.#writeCommand(command))
    this.#writeTail = pending.catch((cause: unknown) => this.#fail(cause))
    return pending
  }

  async #writeCommand(command: object): Promise<void> {
    if (this.#disposed) return
    await this.#child.stdin.write(`${JSON.stringify(command)}\n`)
    await this.#child.stdin.flush()
  }

  async #readOutput(): Promise<void> {
    try {
      await readLines(this.#child.stdout, (line) => this.#handleLine(line))
    } catch (cause) {
      this.#fail(cause)
    }
  }

  async #readErrors(): Promise<void> {
    try {
      const details = (await new Response(this.#child.stderr).text()).trim()
      if (details.length > 0 && !this.#disposed) console.error('PTY sidecar stderr', details)
    } catch (cause) {
      if (!this.#disposed) console.error('Unable to read PTY sidecar stderr', cause)
    }
  }

  async #handleLine(line: string): Promise<void> {
    const message = parseBridgeMessage(line)
    if (message.type === 'output') {
      await this.#sendOutput(message.data)
      return
    }
    if (message.type === 'error') {
      this.#fail(new TypeError(message.message))
      return
    }
    if (!this.#disposed) this.#socket.close(1000, 'PTY exited')
    this.dispose()
  }

  async #sendOutput(encoded: string): Promise<void> {
    if (this.#disposed) return
    const bytes = decodeBase64(encoded)
    const status = this.#socket.sendBinary(bytes)
    if (status === 0) {
      this.dispose()
      return
    }
    if (status < 0) await this.#waitForDrain()
  }

  #waitForDrain(): Promise<void> {
    if (this.#drainPromise) return this.#drainPromise
    this.#drainPromise = new Promise((resolve) => {
      this.#resolveDrain = resolve
    })
    return this.#drainPromise
  }

  #handleChildExit(): void {
    if (this.#disposed) return
    this.#socket.close(1011, 'PTY sidecar exited')
    this.dispose()
  }

  #fail(cause: unknown): void {
    if (this.#disposed) return
    console.error('PTY bridge failed', cause)
    this.#socket.close(1011, 'PTY bridge failed')
    this.dispose()
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      buffer = await consumeBridgeChunk(buffer, result.value, decoder, onLine)
    }
    buffer += decoder.decode()
    buffer = await consumeLines(buffer, onLine)
    if (buffer.length > 0) throw new TypeError('PTY sidecar ended with an incomplete message')
  } finally {
    reader.releaseLock()
  }
}

async function consumeBridgeChunk(
  buffer: string,
  chunk: Uint8Array,
  decoder: TextDecoder,
  onLine: (line: string) => Promise<void>,
): Promise<string> {
  const remainder = await consumeLines(buffer + decoder.decode(chunk, { stream: true }), onLine)
  if (remainder.length <= MAX_BRIDGE_LINE_CHARS) return remainder
  throw new RangeError('PTY sidecar message exceeds the size limit')
}

async function consumeLines(
  initial: string,
  onLine: (line: string) => Promise<void>,
): Promise<string> {
  let buffer = initial
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    if (newline > MAX_BRIDGE_LINE_CHARS) {
      throw new RangeError('PTY sidecar message exceeds the size limit')
    }
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) await onLine(line)
    newline = buffer.indexOf('\n')
  }
  return buffer
}

function parseBridgeMessage(line: string): BridgeMessage {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    throw new TypeError('PTY sidecar emitted invalid JSON')
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new TypeError('PTY sidecar emitted an invalid message')
  }
  if (value.type === 'output' && typeof value.data === 'string') {
    return { type: 'output', data: value.data }
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return { type: 'error', message: value.message }
  }
  if (
    value.type !== 'exit' ||
    !isNullableInteger(value.exitCode) ||
    !isNullableInteger(value.signal)
  ) {
    throw new TypeError('PTY sidecar emitted an invalid message type')
  }
  return { type: 'exit', exitCode: value.exitCode, signal: value.signal }
}

function decodeBase64(encoded: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new TypeError('PTY sidecar emitted invalid base64')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded)
    throw new TypeError('PTY sidecar emitted non-canonical base64')
  return bytes
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || Number.isInteger(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveNodeBinary(explicit: string | undefined): string {
  if (explicit !== undefined) return requireRealNode(explicit)

  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = resolveCandidate(join(directory, executable))
    if (candidate === undefined) continue
    if (basename(candidate).toLowerCase().startsWith('bun')) continue
    if (isRealNode(candidate)) return candidate
  }
  throw new TypeError('A real Node.js binary is required to run the demo PTY sidecar')
}

function requireRealNode(candidate: string): string {
  const resolved = resolveCandidate(candidate)
  if (resolved !== undefined && isRealNode(resolved)) return resolved
  throw new TypeError('The configured PTY runtime is not a real Node.js binary')
}

function resolveCandidate(candidate: string): string | undefined {
  try {
    return realpathSync(candidate)
  } catch {
    return undefined
  }
}

function isRealNode(candidate: string): boolean {
  try {
    const probe = Bun.spawnSync({
      cmd: [candidate, '-e', 'process.stdout.write(typeof Bun)'],
      stderr: 'ignore',
      stdout: 'pipe',
    })
    return probe.success && probe.stdout.toString() === 'undefined'
  } catch {
    return false
  }
}

function installShutdownHandlers(stop: () => Promise<void>, sessions: Set<PtyBridge>): () => void {
  const handleExit = (): void => disposeSessions(sessions)
  const handleInterrupt = (): void => requestSignalStop(stop, 130)
  const handleTermination = (): void => requestSignalStop(stop, 143)
  process.once('exit', handleExit)
  process.once('SIGINT', handleInterrupt)
  process.once('SIGTERM', handleTermination)
  return () => {
    process.removeListener('exit', handleExit)
    process.removeListener('SIGINT', handleInterrupt)
    process.removeListener('SIGTERM', handleTermination)
  }
}

function requestSignalStop(stop: () => Promise<void>, exitCode: number): void {
  process.exitCode = exitCode
  void stop().catch((cause: unknown) => console.error('Demo shutdown failed', cause))
}

function disposeSessions(sessions: Set<PtyBridge>): void {
  for (const session of sessions) session.dispose()
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

if (import.meta.main) {
  startDemoServer()
    .then((server) => console.log(`ghostty-webgpu demo: ${server.origin}`))
    .catch((cause: unknown) => {
      console.error('Unable to start the ghostty-webgpu demo', cause)
      process.exitCode = 1
    })
}
