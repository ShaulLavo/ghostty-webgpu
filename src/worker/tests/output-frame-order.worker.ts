import { TerminalWorkerRuntime } from '../runtime.js'
import type { WorkerInitialize, WorkerMessage, WorkerRequest } from '../protocol.js'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInitialize>) => void) | null
}

scope.onmessage = ({ data }) => {
  scope.onmessage = null
  const transport = new MessageChannel()
  const close = globalThis.close.bind(globalThis)
  let closing = false
  let disposalId: number | undefined
  // Relay the actor's final acknowledgement before terminating its fixture transport.
  globalThis.close = () => {
    closing = true
  }
  let refreshControl: number | undefined
  let outputControl: number | undefined
  let producerPending = false
  let producerReleaseRequested = false
  const held: WorkerRequest[] = []
  const frames: WorkerMessage[] = []

  function forward(request: WorkerRequest): void {
    const transfer: Transferable[] = []
    if (request.command === 'open' || request.command === 'attachOutput')
      transfer.push(request.args[0])
    transport.port1.postMessage(request, transfer)
  }

  function forwardQueued(): void {
    while (held.length > 0) {
      const request = held.shift()!
      forward(request)
      if (
        request.command === 'write' ||
        request.command === 'writeln' ||
        request.command === 'writeAndReadGeometry'
      ) {
        outputControl = request.control
        return
      }
    }
  }

  function release(): void {
    if (held.length === 0 || frames.length === 0) return
    if (producerPending && !producerReleaseRequested) return
    for (const frame of frames.splice(0)) data.port.postMessage(frame)
    producerPending = false
    refreshControl = undefined
    forwardQueued()
  }

  data.port.onmessage = ({ data: request }: MessageEvent<WorkerRequest>) => {
    if (request.command === 'refresh') refreshControl = request.control
    if (request.command === 'dispose') disposalId = request.id
    if (producerPending && (request.command === 'write' || request.command === 'fence'))
      producerReleaseRequested = true
    // Deliver the real output or refresh submission after the page posts the next control.
    if (
      request.command !== 'refresh' &&
      (refreshControl !== undefined || outputControl !== undefined || producerPending)
    ) {
      held.push(request)
      release()
      return
    }
    if (request.command === 'attachOutput') producerPending = true
    forward(request)
  }
  transport.port1.onmessage = ({ data: message }: MessageEvent<WorkerMessage>) => {
    if (
      message.type === 'frame' &&
      (message.control === refreshControl || (producerPending && message.output > 0))
    ) {
      frames.push(message)
      release()
      return
    }
    data.port.postMessage(message)
    if (message.type === 'frame' && message.control === outputControl) {
      outputControl = undefined
      forwardQueued()
    }
    if (closing && message.type === 'reply' && (message.id === disposalId || message.failure))
      close()
  }
  data.port.start()
  transport.port1.start()
  void new TerminalWorkerRuntime({ ...data, port: transport.port2 }).start()
}
