import { expect, test } from 'bun:test'
import { serveShell } from '../src/examples/pty-server.js'

const unavailable = process.platform === 'win32' || !Bun.which('bash')

test.skipIf(unavailable)(
  'PTY tutorial round-trip requires Bun PTY and Bash',
  async () => {
    const server = serveShell(0)
    const url = `http://127.0.0.1:${server.port}/pty`
    let socket: WebSocket | undefined
    try {
      for (const origin of ['https://example.org', 'invalid', '']) {
        const response = await fetch(url, { headers: { origin } })
        expect(response.status).toBe(403)
      }
      socket = new WebSocket(url.replace('http:', 'ws:'), {
        headers: { Origin: 'http://localhost:5173' },
      })
      socket.binaryType = 'arraybuffer'
      const connection = socket
      let output = ''
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject('PTY round-trip timed out'), 5000)
        connection.onerror = (event) => {
          clearTimeout(timer)
          reject(event)
        }
        connection.onopen = () => {
          connection.send(JSON.stringify({ type: 'resize', columns: 91, rows: 17 }))
          connection.send(new TextEncoder().encode("printf 'DOCS_PTY_OK\\n'; stty size\n"))
        }
        connection.onmessage = (event) => {
          output += new TextDecoder().decode(event.data)
          if (!output.includes('DOCS_PTY_OK') || !output.includes('17 91')) return
          clearTimeout(timer)
          resolve()
        }
      })
      const closed = new Promise<number>((resolve) => {
        connection.onclose = (event) => resolve(event.code)
      })
      connection.send('{')
      expect(await closed).toBe(1003)
    } finally {
      socket?.close()
      await server.stop(true)
    }
  },
  10000,
)
