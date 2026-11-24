import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const prefix = '/__ghostty_font_loading__/'
type Gate = ReturnType<typeof Promise.withResolvers<void>>
type Gates = Map<string, Gate>
// Gates whose font request has reached the server; a release before that would 404 the request.
const held = new WeakSet<Gate>()

function release(gates: Gates, key: string, gate = gates.get(key)): void {
  if (!gate) return
  if (gates.get(key) === gate) gates.delete(key)
  gate.resolve()
}

function fontResponse(
  gates: Gates,
  key: string,
  gate: Gate,
  response: ServerResponse,
  bytes: Buffer,
): void {
  held.add(gate)
  response.once('close', () => release(gates, key, gate))
  void gate.promise.then(() => {
    if (response.destroyed || response.writableEnded) return
    response.setHeader('Content-Type', 'font/woff2')
    response.end(bytes)
    release(gates, key, gate)
  })
}

function handle(
  gates: Gates,
  bytes: Buffer,
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  if (!request.url?.startsWith(prefix)) return next()
  const url = new URL(request.url, 'http://localhost')
  const key = url.pathname
  response.setHeader('Cache-Control', 'no-store')
  if (!/^[\w-]{1,128}$/.test(key.slice(prefix.length))) {
    response.writeHead(400).end()
    return
  }
  const control = url.search === '?control'
  if (control && request.method === 'POST') {
    if (gates.has(key)) {
      response.writeHead(409).end()
      return
    }
    gates.set(key, Promise.withResolvers<void>())
    response.writeHead(204).end()
    return
  }
  if (control && request.method === 'DELETE') {
    release(gates, key)
    response.writeHead(204).end()
    return
  }
  if (url.search === '?waiting' && request.method === 'GET') {
    const gate = gates.get(key)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(gate !== undefined && held.has(gate)))
    return
  }
  if (url.search || request.method !== 'GET') {
    response.writeHead(400).end()
    return
  }
  const gate = gates.get(key)
  if (!gate) {
    response.writeHead(404).end()
    return
  }
  fontResponse(gates, key, gate, response, bytes)
}

export function fontLoadingFixture(): Plugin {
  const bytes = readFileSync(
    new URL('../src/dom/tests/fixtures/font-resource/before.woff2', import.meta.url),
  )
  const gates: Gates = new Map()
  return {
    name: 'ghostty-font-loading-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) =>
        handle(gates, bytes, request, response, next),
      )
    },
    closeBundle() {
      for (const [key, gate] of gates) release(gates, key, gate)
    },
  }
}
