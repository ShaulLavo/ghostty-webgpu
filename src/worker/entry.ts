import { TerminalWorkerRuntime } from './runtime.js'
import type { WorkerCancel, WorkerInitialize } from './protocol.js'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInitialize | WorkerCancel>) => void) | null
}
const runtimes = new Map<string, TerminalWorkerRuntime>()
// A pooled worker starts one runtime per terminal; a dedicated one accepts a single initialize.
scope.onmessage = ({ data }) => {
  if (data?.type === 'cancel') {
    const runtime = runtimes.get(data.terminal)
    if (runtime?.generation === data.generation) runtime.cancel()
    return
  }
  if (!data.pooled) scope.onmessage = null
  const runtime = new TerminalWorkerRuntime(data, undefined, () => runtimes.delete(data.terminal))
  runtimes.set(data.terminal, runtime)
  void runtime.start()
}
