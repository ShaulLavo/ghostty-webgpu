import assert from 'node:assert/strict'
import { once } from 'node:events'

export async function websocketControl(url: URL, token: string): Promise<void> {
  url.protocol = 'ws:'
  url.searchParams.set('token', token)
  const socket = new WebSocket(url, 'vite-hmr')
  const received = once(socket, 'message', { signal: AbortSignal.timeout(2000) })
  void received.catch(() => {})
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(2000) })
    const [message]: unknown[] = await received
    assert(message instanceof MessageEvent && typeof message.data === 'string')
    const body: unknown = JSON.parse(message.data)
    assert(typeof body === 'object' && body !== null && 'type' in body)
    assert.equal(body.type, 'connected')
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) })
      socket.close()
      await closed
    }
  }
}
