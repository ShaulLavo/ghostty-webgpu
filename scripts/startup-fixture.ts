import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

// Startup-order fixture: serves the core wasm and the packaged worker per scenario, records which
// side requested each file and in what order, and can hold the wasm, fail it, or hold the worker
// entry until the page has requested both wasm files.
const prefix = '/__ghostty_startup__/'
const root = fileURLToPath(new URL('../', import.meta.url))
const workerDistDir = resolve(root, 'dist/worker')
const wasmFiles = new Set(['ghostty-vt.wasm', 'bridge.wasm'])

interface ScenarioState {
  holdWasm: boolean
  failWasm: boolean
  gateEntry: boolean
  readonly events: string[]
  readonly held: (() => void)[]
}

type ScenarioControl = Partial<Pick<ScenarioState, 'holdWasm' | 'failWasm' | 'gateEntry'>>

function emptyState(): ScenarioState {
  return { holdWasm: false, failWasm: false, gateEntry: false, events: [], held: [] }
}

// Worker fetches carry the worker script as their referrer; page fetches carry the test page.
function requester(request: IncomingMessage): 'page' | 'worker' {
  return (request.headers.referer ?? '').includes(prefix) ? 'worker' : 'page'
}

function pageRequestedBothWasm(state: ScenarioState): boolean {
  return [...wasmFiles].every((file) => state.events.includes(`page:${file}`))
}

function releaseGates(state: ScenarioState): void {
  for (const release of state.held.splice(0)) release()
}

function gpuWrapperSource(scenario: string, mode: string): string {
  return `import './entry.js'
const channel = new BroadcastChannel(${JSON.stringify(`startup-${scenario}`)})
const mode = ${JSON.stringify(mode)}
const gpu = navigator.gpu
const realRequestAdapter = gpu ? gpu.requestAdapter.bind(gpu) : async () => null
let calls = 0
let release
const released = new Promise((resolve) => (release = resolve))
channel.onmessage = ({ data }) => {
  if (data === 'release') release()
}
function reportDevices(adapter) {
  if (!adapter) return adapter
  const requestDevice = adapter.requestDevice.bind(adapter)
  adapter.requestDevice = async (descriptor) => {
    const device = await requestDevice(descriptor)
    channel.postMessage('device')
    const destroy = device.destroy.bind(device)
    device.destroy = () => {
      channel.postMessage('destroyed')
      destroy()
    }
    return device
  }
  return adapter
}
if (gpu)
  Object.defineProperty(gpu, 'requestAdapter', {
    configurable: true,
    value: async (options) => {
      calls += 1
      channel.postMessage('adapter-' + calls)
      if (mode === 'no-adapter') return null
      if (mode === 'late-adapter' && calls === 1) return null
      if (mode === 'held-adapter') await released
      return reportDevices(await realRequestAdapter(options))
    },
  })
`
}

// Turns the page's first module handoff into a receive-side clone failure.
function messageErrorWrapperSource(): string {
  return `import './entry.js'
const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')
let converted = false
Object.defineProperty(MessagePort.prototype, 'onmessage', {
  configurable: true,
  get() {
    return descriptor.get.call(this)
  },
  set(handler) {
    const port = this
    descriptor.set.call(this, (event) => {
      if (!converted && event.data && event.data.type === 'modules') {
        converted = true
        port.onmessageerror(new MessageEvent('messageerror'))
        return
      }
      handler(event)
    })
  },
})
`
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function controlFrom(body: Record<string, unknown>): ScenarioControl {
  const control: ScenarioControl = {}
  for (const key of ['holdWasm', 'failWasm', 'gateEntry'] as const) {
    if (typeof body[key] === 'boolean') control[key] = body[key]
  }
  return control
}

async function handleControl(
  scenarios: Map<string, ScenarioState>,
  scenario: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const state = scenarios.get(scenario) ?? emptyState()
  scenarios.set(scenario, state)
  if (request.method === 'DELETE') {
    releaseGates(state)
    scenarios.delete(scenario)
    response.writeHead(204).end()
    return
  }
  if (request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ events: state.events }))
    return
  }
  Object.assign(state, controlFrom(await readJsonBody(request)))
  if (!state.holdWasm && !state.gateEntry) releaseGates(state)
  response.writeHead(204).end()
}

function sendFile(response: ServerResponse, path: string, type: string): void {
  if (!existsSync(path)) {
    response.writeHead(404).end()
    return
  }
  response.setHeader('Content-Type', type)
  response.end(readFileSync(path))
}

function serveWasm(state: ScenarioState, file: string, response: ServerResponse): void {
  const send = () => {
    state.events.push(`sent:${file}`)
    if (state.failWasm) {
      response.writeHead(503).end('Injected wasm 503')
      return
    }
    sendFile(response, resolve(root, file), 'application/wasm')
  }
  if (pageRequestedBothWasm(state) && state.gateEntry && !state.holdWasm) releaseGates(state)
  if (state.holdWasm) {
    state.held.push(send)
    return
  }
  send()
}

function serveWorker(
  state: ScenarioState,
  scenario: string,
  file: string,
  search: URLSearchParams,
  response: ServerResponse,
): void {
  const script = 'text/javascript; charset=utf-8'
  if (file === 'gpu-entry.js') {
    response.setHeader('Content-Type', script)
    response.end(gpuWrapperSource(scenario, search.get('mode') ?? 'real'))
    return
  }
  if (file === 'messageerror-entry.js') {
    response.setHeader('Content-Type', script)
    response.end(messageErrorWrapperSource())
    return
  }
  if (file !== 'entry.js' && !/^chunk-[a-z0-9]+\.js$/.test(file)) {
    response.writeHead(404).end()
    return
  }
  const send = () => {
    if (file === 'entry.js') state.events.push('sent:entry.js')
    sendFile(response, resolve(workerDistDir, file), script)
  }
  if (file === 'entry.js' && state.gateEntry && !pageRequestedBothWasm(state)) {
    state.held.push(send)
    return
  }
  send()
}

function handleRequest(
  scenarios: Map<string, ScenarioState>,
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  if (!request.url?.startsWith(prefix)) return next()
  const url = new URL(request.url, 'http://localhost')
  const [scenario, file, ...rest] = url.pathname.slice(prefix.length).split('/').filter(Boolean)
  if (!scenario || !/^[\w-]{1,128}$/.test(scenario) || rest.length > 0) {
    response.writeHead(400).end()
    return
  }
  response.setHeader('Cache-Control', 'no-store')
  if (!file && (url.search === '?control' || url.search === '?status')) {
    void handleControl(scenarios, scenario, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(400).end()
    })
    return
  }
  const state = scenarios.get(scenario) ?? emptyState()
  scenarios.set(scenario, state)
  if (!file || request.method !== 'GET') {
    response.writeHead(400).end()
    return
  }
  state.events.push(`${requester(request)}:${file}`)
  if (wasmFiles.has(file)) {
    serveWasm(state, file, response)
    return
  }
  serveWorker(state, scenario, file, url.searchParams, response)
}

export function startupFixture(): Plugin {
  const scenarios = new Map<string, ScenarioState>()
  return {
    name: 'ghostty-startup-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) =>
        handleRequest(scenarios, request, response, next),
      )
    },
    closeBundle() {
      for (const state of scenarios.values()) releaseGates(state)
      scenarios.clear()
    },
  }
}
