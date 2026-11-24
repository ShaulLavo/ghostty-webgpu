import { TerminalWorkerRuntime } from './runtime.js'
import type { WorkerInitialize } from './protocol.js'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInitialize>) => void) | null
}
// A pooled worker starts one runtime per terminal; a dedicated one accepts a single initialize.
scope.onmessage = ({ data }) => {
  if (!data.pooled) scope.onmessage = null
  void new TerminalWorkerRuntime(data).start()
}
