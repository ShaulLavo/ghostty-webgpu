import { fileURLToPath } from 'node:url'

const outDir = fileURLToPath(new URL('./dist/', import.meta.url))
const port = Number(process.env['PORT'] ?? 4321)
const types: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url)
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    if (pathname.includes('..')) return new Response('Not found', { status: 404 })
    const file = Bun.file(`${outDir}${pathname.slice(1)}`)
    if (!(await file.exists())) return new Response('Not found', { status: 404 })
    const extension = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, {
      headers: { 'content-type': types[extension] ?? 'application/octet-stream' },
    })
  },
})

console.log(`ghostty-webgpu site: ${server.url}`)
