import { TerminalWorkerRuntime } from '../runtime.js'
import type { WorkerInitialize, WorkerMessage, WorkerRequest } from '../protocol.js'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInitialize>) => void) | null
}
const parameters = new URL(location.href).searchParams
const mode = parameters.get('mode')
const channel = new BroadcastChannel(parameters.get('channel')!)
let armed = false
let last: Extract<WorkerMessage, { type: 'frame' }> | undefined

scope.onmessage = ({ data }) => {
  scope.onmessage = null
  const transport = new MessageChannel()
  const close = globalThis.close.bind(globalThis)
  let closing = false
  globalThis.close = () => {
    closing = true
  }
  data.port.onmessage = ({ data: request }: MessageEvent<WorkerRequest>) => {
    const transfer: Transferable[] = []
    if (request.command === 'open' || request.command === 'attachOutput')
      transfer.push(request.args[0])
    transport.port1.postMessage(request, transfer)
  }
  channel.onmessage = ({ data: command }: MessageEvent<unknown>) => {
    if (command === 'arm') {
      armed = true
      channel.postMessage('armed')
      return
    }
    if (command !== 'malformed' || !last) return
    data.port.postMessage({ ...last, base: last.frame, frame: last.frame + 1, revisions: [] })
  }
  function frame(message: Extract<WorkerMessage, { type: 'frame' }>): void {
    last = message
    if (!armed) {
      data.port.postMessage(message)
      return
    }
    armed = false
    if (mode === 'drop') return
    if (mode === 'epoch') {
      data.port.postMessage({ ...message, store: message.store + 2 })
      return
    }
    if (mode === 'missing') {
      data.port.postMessage({ ...message, content: [] })
      return
    }
    if (mode === 'foreign') data.port.postMessage({ ...message, terminal: 'foreign-copy' })
    data.port.postMessage(message)
  }
  transport.port1.onmessage = ({ data: message }: MessageEvent<WorkerMessage>) => {
    if (message.type === 'frame') frame(message)
    else data.port.postMessage(message)
    if (closing && message.type === 'reply') {
      channel.close()
      close()
    }
  }
  data.port.start()
  transport.port1.start()
  void new TerminalWorkerRuntime({ ...data, port: transport.port2 }).start()
}
