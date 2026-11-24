export interface TerminalWorkerPoolOptions {
  /** Most workers the pool runs at once. Terminals beyond this share the least loaded worker. */
  readonly workers?: number
}

export interface WorkerLease {
  readonly worker: Worker
  release(): void
}

export interface WorkerLeaseListeners {
  error(event: ErrorEvent): void
  messageError(): void
}

interface PooledWorker {
  readonly url: string
  readonly worker: Worker
  readonly listeners: Set<WorkerLeaseListeners>
  failed: boolean
}

export function createTerminalWorker(url: string | URL | undefined): Worker {
  if (url !== undefined) return new Worker(url, { type: 'module' })
  return new Worker(new URL('./entry.js', import.meta.url), { type: 'module' })
}

/** Runs many terminals on a few workers. A worker stops when its last terminal is disposed. */
export class TerminalWorkerPool {
  readonly workers: number
  private readonly running: PooledWorker[] = []

  constructor(options: TerminalWorkerPoolOptions = {}) {
    const workers = options.workers ?? defaultPoolWorkers()
    if (!Number.isSafeInteger(workers) || workers < 1)
      throw new RangeError('workers must be a positive integer')
    this.workers = workers
  }

  /** @internal */
  lease(url: string | URL | undefined, listeners: WorkerLeaseListeners): WorkerLease {
    const key = url === undefined ? '' : String(url)
    const entry = this.select(key) ?? this.start(url, key)
    entry.listeners.add(listeners)
    let released = false
    return {
      worker: entry.worker,
      release: () => {
        if (released) return
        released = true
        entry.listeners.delete(listeners)
        if (entry.listeners.size === 0) this.stop(entry)
      },
    }
  }

  private select(key: string): PooledWorker | undefined {
    const candidates = this.running.filter((entry) => entry.url === key && !entry.failed)
    if (candidates.length < this.workers) return undefined
    let best = candidates[0]
    for (const entry of candidates) {
      if (entry.listeners.size < best!.listeners.size) best = entry
    }
    return best
  }

  private start(url: string | URL | undefined, key: string): PooledWorker {
    const worker = createTerminalWorker(url)
    const entry: PooledWorker = { url: key, worker, listeners: new Set(), failed: false }
    worker.onerror = (event) => {
      event.preventDefault()
      entry.failed = true
      // Each failing terminal releases itself; deleting the visited Set entry is safe.
      for (const listener of entry.listeners) listener.error(event)
    }
    worker.onmessageerror = () => {
      for (const listener of entry.listeners) listener.messageError()
    }
    this.running.push(entry)
    return entry
  }

  private stop(entry: PooledWorker): void {
    const index = this.running.indexOf(entry)
    if (index >= 0) this.running.splice(index, 1)
    entry.worker.terminate()
  }
}

// Half the logical cores keeps the page and GPU process off the workers' cores.
function defaultPoolWorkers(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4
  return Math.max(1, Math.min(8, Math.floor(cores / 2)))
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
  return { worker, release: () => worker.terminate() }
}
