import { TerminalWorkerRuntime } from '../runtime.js'
import type { WorkerCancel, WorkerInitialize } from '../protocol.js'

// No animation frames, and each page `drained` waits until the test posts on the release channel,
// so only a paint that bypasses the settle gate can show output.
const scope = globalThis as unknown as {
  requestAnimationFrame(callback: FrameRequestCallback): number
  onmessage: ((event: MessageEvent<WorkerInitialize | WorkerCancel>) => void) | null
}
scope.requestAnimationFrame = () => 0

let holding = true
const held: (() => void)[] = []
const release = new BroadcastChannel('withheld-drained')
release.onmessage = () => {
  holding = false
  for (const send of held.splice(0)) send()
}

type PageMessage = {
  readonly type?: string
  readonly command?: string
  readonly args?: unknown[]
  readonly canvas?: OffscreenCanvas
}

function transferables(message: PageMessage): Transferable[] {
  if (message?.type === 'canvas' && message.canvas) return [message.canvas]
  if (message?.command === 'open' || message?.command === 'attachOutput')
    return [message.args![0] as Transferable]
  return []
}

const runtimes = new Map<string, TerminalWorkerRuntime>()
scope.onmessage = ({ data }) => {
  if (data?.type === 'cancel') {
    const runtime = runtimes.get(data.terminal)
    if (runtime?.generation === data.generation) runtime.cancel()
    return
  }
  const relay = new MessageChannel()
  const page = data.port
  page.onmessage = ({ data: message }: MessageEvent<PageMessage>) => {
    const send = () => relay.port1.postMessage(message, transferables(message))
    if (holding && message?.type === 'drained') {
      held.push(send)
      return
    }
    send()
  }
  relay.port1.onmessage = ({ data: message }) => page.postMessage(message)
  page.start()
  relay.port1.start()
  const runtime = new TerminalWorkerRuntime({ ...data, port: relay.port2 }, undefined, () =>
    runtimes.delete(data.terminal),
  )
  runtimes.set(data.terminal, runtime)
  void runtime.start()
}
