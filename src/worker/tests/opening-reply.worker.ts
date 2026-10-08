import '../../../dist/worker/entry.js'
import type { WorkerInitialize, WorkerMessage, WorkerRequest } from '../protocol.js'

const scope = globalThis as unknown as {
  onmessage(event: MessageEvent<WorkerInitialize>): void
}
const initialize = scope.onmessage
scope.onmessage = (event) => {
  const port = event.data.port
  let opening: number | undefined
  port.addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
    if (data.command === 'open') opening = data.id
  })
  const send = port.postMessage.bind(port)
  port.postMessage = (message: WorkerMessage) => {
    if (message.type === 'reply' && message.id === opening && !message.failure) {
      send({ ...message, result: undefined })
      return
    }
    send(message)
  }
  initialize(event)
}
