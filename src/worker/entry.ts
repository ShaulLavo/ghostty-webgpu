import { TerminalWorkerRuntime } from './runtime.js'
import type { WorkerInitialize } from './protocol.js'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInitialize>) => void) | null
}
scope.onmessage = ({ data }) => {
  scope.onmessage = null
  void new TerminalWorkerRuntime(data).start()
}
