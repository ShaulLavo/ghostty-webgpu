import type { ProducerObservation } from './worker-protocol.js'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MessagePort>) => void) | null
  postMessage: (message: ProducerObservation) => void
}

scope.onmessage = ({ data: port }) => {
  scope.onmessage = null
  const bytes = new TextEncoder().encode('direct-port-output')
  port.postMessage(bytes, [bytes.buffer])
  port.close()
  scope.postMessage({ type: 'sent', bufferDetached: bytes.byteLength === 0 })
}
