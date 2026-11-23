import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const prefix = '/__ghostty_worker_chunk__/'
const workerDistDir = fileURLToPath(new URL('../dist/worker/', import.meta.url))

type FailureMode = 'all-renderers' | 'none' | 'webgl' | 'webgpu'

interface ScenarioState {
  fail: FailureMode
  readonly failed: string[]
  readonly requests: string[]
}

function classifyChunk(source: string): 'webgl' | 'webgpu' | 'other' {
  if (source.includes('getPreferredCanvasFormat') && source.includes('createRenderPipeline'))
    return 'webgpu'
  if (source.includes('#version 300 es')) return 'webgl'
  return 'other'
}

function shouldFail(mode: FailureMode, kind: 'webgl' | 'webgpu' | 'other'): boolean {
  if (mode === 'none' || kind === 'other') return false
  if (mode === 'all-renderers') return true
  return mode === kind
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveBody(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch (cause) {
        reject(cause)
      }
    })
    request.on('error', reject)
  })
}

function macosWrapperSource(scenario: string): string {
  return `import './entry.js'
const channel = new BroadcastChannel(${JSON.stringify(`worker-chunk-${scenario}`)})
Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh)' })
Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'macOS' } })
Object.defineProperty(navigator, 'gpu', {
  configurable: true,
  value: {
    getPreferredCanvasFormat: () => 'bgra8unorm',
    requestAdapter: async () => ({
      isFallbackAdapter: false,
      info: { description: 'Test hardware adapter' },
      requestDevice: async () => {
        channel.postMessage('device')
        return {
          queue: { onSubmittedWorkDone: async () => {} },
          destroy() {
            channel.postMessage('destroyed')
          },
        }
      },
    }),
  },
})
`
}

async function handleControl(
  scenarios: Map<string, ScenarioState>,
  scenario: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === 'DELETE') {
    scenarios.delete(scenario)
    response.writeHead(204).end()
    return
  }
  if (request.method === 'GET') {
    const state = scenarios.get(scenario) ?? { fail: 'none', failed: [], requests: [] }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(state))
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end()
    return
  }
  const body = await readJsonBody(request)
  const fail = body.fail
  if (fail !== 'all-renderers' && fail !== 'none' && fail !== 'webgl' && fail !== 'webgpu') {
    response.writeHead(400).end()
    return
  }
  const existing = scenarios.get(scenario)
  if (existing) {
    existing.fail = fail
  } else {
    scenarios.set(scenario, { fail, failed: [], requests: [] })
  }
  response.writeHead(204).end()
}

function serveWorkerFile(
  scenarios: Map<string, ScenarioState>,
  scenario: string,
  fileName: string,
  response: ServerResponse,
): void {
  if (fileName === 'macos-entry.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    response.end(macosWrapperSource(scenario))
    return
  }
  if (fileName !== 'entry.js' && !/^chunk-[a-z0-9]+\.js$/.test(fileName)) {
    response.writeHead(404).end()
    return
  }
  const fullPath = resolve(workerDistDir, fileName)
  if (!existsSync(fullPath)) {
    response.writeHead(404).end()
    return
  }
  const source = readFileSync(fullPath, 'utf8')
  const state = scenarios.get(scenario)
  if (state && fileName !== 'entry.js') {
    const kind = classifyChunk(source)
    if (kind !== 'other') state.requests.push(kind)
    if (shouldFail(state.fail, kind)) {
      state.failed.push(kind)
      response.writeHead(503).end('Injected worker chunk 503')
      return
    }
  }
  response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
  response.end(source)
}

function handleRequest(
  scenarios: Map<string, ScenarioState>,
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  if (!request.url?.startsWith(prefix)) return next()
  const url = new URL(request.url, 'http://localhost')
  const segments = url.pathname.slice(prefix.length).split('/').filter(Boolean)
  const [scenario, fileName] = segments
  if (!scenario || !/^[\w-]{1,128}$/.test(scenario)) {
    response.writeHead(400).end()
    return
  }
  response.setHeader('Cache-Control', 'no-store')
  if (!fileName && (url.search === '?control' || url.search === '?status')) {
    void handleControl(scenarios, scenario, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(400).end()
    })
    return
  }
  if (!fileName || segments.length !== 2 || request.method !== 'GET') {
    response.writeHead(400).end()
    return
  }
  serveWorkerFile(scenarios, scenario, fileName, response)
}

export function workerChunkFixture(): Plugin {
  const scenarios = new Map<string, ScenarioState>()
  return {
    name: 'ghostty-worker-chunk-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) =>
        handleRequest(scenarios, request, response, next),
      )
    },
    closeBundle() {
      scenarios.clear()
    },
  }
}
