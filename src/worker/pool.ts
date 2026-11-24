import type { WorkerFontFace } from './protocol.js'

export interface TerminalWorkerPoolOptions {
  /** Most workers per worker URL and font set. Further terminals share the least loaded worker. */
  readonly workers?: number
}

export interface WorkerLease {
  readonly worker: Worker
  /** Tells the worker to tear this terminal down; the page no longer talks to it. */
  cancel(terminal: string, generation: number): void
  release(): void
}

export interface WorkerLeaseListeners {
  error(event: ErrorEvent): void
  messageError(): void
}

interface PooledWorker {
  readonly key: string
  readonly worker: Worker
  readonly listeners: Set<WorkerLeaseListeners>
  failed: boolean
}

interface PoolState {
  readonly workers: number
  readonly running: PooledWorker[]
}

const pools = new WeakMap<TerminalWorkerPool, PoolState>()
const byteSources = new WeakMap<object, number>()
let nextByteSource = 0

export function createTerminalWorker(url: string | URL | undefined): Worker {
  if (url !== undefined) return new Worker(url, { type: 'module' })
  return new Worker(new URL('./entry.js', import.meta.url), { type: 'module' })
}

/** Runs many terminals on a few workers. A worker stops when its last terminal is disposed. */
export class TerminalWorkerPool {
  readonly workers: number

  constructor(options: TerminalWorkerPoolOptions = {}) {
    const workers = options.workers ?? defaultPoolWorkers()
    if (!Number.isSafeInteger(workers) || workers < 1)
      throw new RangeError('workers must be a positive integer')
    this.workers = workers
    pools.set(this, { workers, running: [] })
  }
}

// Font matching is worker-wide, so only terminals with the same faces may share a worker.
function fontSetKey(faces: readonly WorkerFontFace[]): string {
  return JSON.stringify(
    faces.map((face) => {
      const source = face.source
      if ('url' in source) return [face.family, source.url, face.descriptors ?? null]
      let id = byteSources.get(source.bytes)
      if (id === undefined) {
        id = ++nextByteSource
        byteSources.set(source.bytes, id)
      }
      return [face.family, id, face.descriptors ?? null]
    }),
  )
}

export function leasePooledWorker(
  pool: TerminalWorkerPool,
  url: string | URL | undefined,
  faces: readonly WorkerFontFace[],
  listeners: WorkerLeaseListeners,
): WorkerLease {
  const state = pools.get(pool)!
  const key = JSON.stringify([url === undefined ? '' : String(url), fontSetKey(faces)])
  const entry = selectWorker(state, key) ?? startWorker(state, url, key)
  entry.listeners.add(listeners)
  let released = false
  return {
    worker: entry.worker,
    cancel: (terminal, generation) => {
      if (released || entry.failed) return
      entry.worker.postMessage({ type: 'cancel', terminal, generation })
    },
    release: () => {
      if (released) return
      released = true
      entry.listeners.delete(listeners)
      if (entry.listeners.size === 0) stopWorker(state, entry)
    },
  }
}

function selectWorker(state: PoolState, key: string): PooledWorker | undefined {
  const candidates = state.running.filter((entry) => entry.key === key && !entry.failed)
  if (candidates.length < state.workers) return undefined
  let best = candidates[0]
  for (const entry of candidates) {
    if (entry.listeners.size < best!.listeners.size) best = entry
  }
  return best
}

function startWorker(state: PoolState, url: string | URL | undefined, key: string): PooledWorker {
  const worker = createTerminalWorker(url)
  const entry: PooledWorker = { key, worker, listeners: new Set(), failed: false }
  worker.onerror = (event) => {
    event.preventDefault()
    entry.failed = true
    // Each failing terminal releases itself; deleting the visited Set entry is safe.
    for (const listener of entry.listeners) listener.error(event)
  }
  worker.onmessageerror = () => {
    for (const listener of entry.listeners) listener.messageError()
  }
  state.running.push(entry)
  return entry
}

function stopWorker(state: PoolState, entry: PooledWorker): void {
  const index = state.running.indexOf(entry)
  if (index >= 0) state.running.splice(index, 1)
  entry.worker.terminate()
}

// Four workers used the least CPU for 16 dense terminals on both an M1 and a 28-thread desktop;
// half the logical cores leaves smaller machines room for the page and GPU process.
function defaultPoolWorkers(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4
  return Math.max(1, Math.min(4, Math.floor(cores / 2)))
}

/** One worker per terminal, the entry's behavior without a pool. */
export function dedicatedWorkerLease(
  url: string | URL | undefined,
  listeners: WorkerLeaseListeners,
): WorkerLease {
  const worker = createTerminalWorker(url)
  worker.onerror = (event) => {
    event.preventDefault()
    listeners.error(event)
  }
  worker.onmessageerror = () => listeners.messageError()
  // Terminating the worker tears its only terminal down.
  return { worker, cancel: () => {}, release: () => worker.terminate() }
}
