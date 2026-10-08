import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'

const mime = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.html': 'text/html',
}

function requestPath(url) {
  try {
    return new URL(url, 'http://127.0.0.1').pathname
  } catch {
    return null
  }
}

export function createFixture(packet, port) {
  const requests = []
  let resolveFailure
  const failure = new Promise((resolve) => {
    resolveFailure = resolve
  })
  function record(receipt) {
    if (requests.length < 1000) requests.push(receipt)
  }
  async function handle(request, response) {
    const pathname = requestPath(request.url)
    const name = pathname?.slice(1) || 'index.html'
    let status = 200,
      body = Buffer.alloc(0),
      type = 'text/plain'
    if (pathname === null || name !== basename(name) || name.includes('\\')) status = 400
    else if (name === 'favicon.ico') status = 204
    else {
      try {
        body = await readFile(join(packet, name))
        type = mime[extname(name)] ?? 'application/octet-stream'
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        status = 404
      }
    }
    record({ pathname, status, bytes: body.byteLength })
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body)
  }
  const server = createServer((request, response) => {
    response.on('error', () => {})
    void handle(request, response).catch((error) => {
      const receipt = {
        pathname: requestPath(request.url),
        status: 500,
        error: error.code ?? error.name,
      }
      record(receipt)
      try {
        if (!response.headersSent && !response.destroyed)
          response.writeHead(500).end('Fixture failure')
        else response.destroy()
      } catch {
        response.destroy()
      } finally {
        resolveFailure({ error, receipt })
      }
    })
  })
  server.on('error', (error) =>
    resolveFailure({
      error,
      receipt: { pathname: null, status: null, error: error.code ?? error.name },
    }),
  )
  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    return server.address().port
  }
  async function close() {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
  return { server, requests, failure, start, close }
}
