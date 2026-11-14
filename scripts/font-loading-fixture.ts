import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

const prefix = '/__ghostty_font_loading__/'

export function fontLoadingFixture(): Plugin {
  const bytes = readFileSync(
    new URL('../src/dom/tests/fixtures/font-resource/before.woff2', import.meta.url),
  )
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  return {
    name: 'ghostty-font-loading-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(prefix)) return next()
        const key = new URL(request.url, 'http://localhost').pathname
        response.setHeader('Cache-Control', 'no-store')
        if (request.method === 'POST') {
          gates.set(key, Promise.withResolvers<void>())
          response.writeHead(204).end()
          return
        }
        const gate = gates.get(key)
        if (request.method === 'DELETE') {
          gate?.resolve()
          response.writeHead(204).end()
          return
        }
        if (!gate || request.method !== 'GET') {
          response.writeHead(404).end()
          return
        }
        void gate.promise.then(() => {
          response.setHeader('Content-Type', 'font/woff2')
          response.end(bytes)
          gates.delete(key)
        })
      })
    },
    closeBundle() {
      for (const gate of gates.values()) gate.resolve()
      gates.clear()
    },
  }
}
