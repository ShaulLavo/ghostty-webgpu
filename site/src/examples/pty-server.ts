interface ShellConnection {
  process?: ReturnType<typeof Bun.spawn>
}

export function serveShell(port = 8080) {
  return Bun.serve<ShellConnection>({
    hostname: '127.0.0.1',
    port,
    fetch(request, server) {
      if (new URL(request.url).pathname !== '/pty')
        return new Response('Missing route', { status: 404 })
      const origin = URL.parse(request.headers.get('origin') ?? '')
      if (origin?.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname))
        return new Response('Loopback browser origin required', { status: 403 })
      if (server.upgrade(request, { data: {} })) return
      return new Response('WebSocket required', { status: 400 })
    },
    websocket: {
      open(socket) {
        socket.data.process = Bun.spawn(['bash', '--noprofile', '--norc'], {
          env: { ...process.env, TERM: 'xterm-256color' },
          terminal: {
            cols: 80,
            rows: 24,
            data(_terminal, bytes) {
              socket.send(bytes)
            },
          },
          onExit() {
            socket.close()
          },
        })
      },
      message(socket, message) {
        const terminal = socket.data.process?.terminal
        if (!terminal) return
        if (typeof message !== 'string') {
          terminal.write(message)
          return
        }
        let size: unknown
        try {
          size = JSON.parse(message)
        } catch {
          socket.close(1003, 'Resize message must be JSON')
          return
        }
        if (!size || typeof size !== 'object' || !('type' in size) || size.type !== 'resize') return
        if (!('columns' in size) || !('rows' in size)) return
        const { columns, rows } = size
        if (typeof columns !== 'number' || typeof rows !== 'number') return
        if (!Number.isInteger(columns) || !Number.isInteger(rows)) return
        if (columns < 1 || columns > 500 || rows < 1 || rows > 200) return
        terminal.resize(columns, rows)
      },
      close(socket) {
        socket.data.process?.kill()
        socket.data.process?.terminal?.close()
      },
    },
  })
}

if (import.meta.main) {
  serveShell()
  console.log('Shell WebSocket listening at ws://127.0.0.1:8080/pty')
}
