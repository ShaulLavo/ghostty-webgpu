import { RenderScheduler } from '../src/render/shared/scheduler.js'
import { TerminalWorkerRuntime } from '../src/worker/runtime.js'
import type { WorkerInitialize } from '../src/worker/protocol.js'

// Study-only completion hook: force this worker's pending draw, then await its GPU queue.
const schedulers = new Set<RenderScheduler>()
const queues = new Set<GPUQueue>()
const schedule = RenderScheduler.prototype.schedule
RenderScheduler.prototype.schedule = function (this: RenderScheduler) {
  schedulers.add(this)
  schedule.call(this)
}
const submit = GPUQueue.prototype.submit
GPUQueue.prototype.submit = function (this: GPUQueue, commands) {
  queues.add(this)
  submit.call(this, commands)
}
addEventListener('message', ({ data }: MessageEvent<{ type?: string; id?: number }>) => {
  if (data?.type !== 'study-complete') return
  for (const scheduler of schedulers) scheduler.flush()
  void Promise.all(Array.from(queues, (queue) => queue.onSubmittedWorkDone())).then(() =>
    postMessage({ type: 'study-completed', id: data.id }),
  )
})

// The published entry's body, inlined: a bare import of it is dropped as side-effect free.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInitialize>) => void) | null
}
scope.onmessage = ({ data }) => {
  scope.onmessage = null
  void new TerminalWorkerRuntime(data).start()
}
