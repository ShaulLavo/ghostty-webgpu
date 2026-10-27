import { createGhosttyError } from '../core/error.js'

const defaultMaxBytes = 8 * 1024 * 1024
const defaultTimeBudgetMs = 12
const compactThreshold = 64

export interface TerminalWriteQueueOptions {
  /** Maximum queued plus worker-inflight UTF-8 bytes. Defaults to 8 MiB. */
  readonly maxBytes?: number
  /** Maximum synchronous batch duration, checked between writes. Defaults to 12 ms. */
  readonly timeBudgetMs?: number
}

export interface TerminalBatchedWriteOptions {
  /** Aborting before parsing removes the write. Active and completed writes are not cancelled. */
  readonly signal?: AbortSignal
}

interface WriteQueueClock {
  now(): number
  setTimeout(callback: () => void): number
  clearTimeout(handle: number): void
}

type EntryState = 'active' | 'cancelled' | 'queued' | 'settled'

interface WriteEntry<T> {
  state: EntryState
  data?: Uint8Array
  readonly bytes: number
  readonly signal?: AbortSignal
  readonly abort?: () => void
  readonly resolve: (result: T) => void
  readonly reject: (cause: unknown) => void
}

const systemClock: WriteQueueClock = {
  now: () => performance.now(),
  setTimeout: (callback) => window.setTimeout(callback, 0),
  clearTimeout: (handle) => window.clearTimeout(handle),
}

function positive(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be greater than zero`)
}

export class TerminalWriteQueue<T> {
  private readonly entries: WriteEntry<T>[] = []
  private readonly active = new Set<WriteEntry<T>>()
  private readonly encoder = new TextEncoder()
  private readonly maxBytes: number
  private readonly timeBudgetMs: number
  private offset = 0
  private pendingBytesValue = 0
  private timer?: number
  private running = false
  private flushRequested = false
  private inputPending = false
  private disposed = false

  constructor(
    private readonly execute: (data: Uint8Array) => T | Promise<T>,
    options: TerminalWriteQueueOptions = {},
    private readonly clock: WriteQueueClock = systemClock,
  ) {
    this.maxBytes = positive('writeQueue.maxBytes', options.maxBytes ?? defaultMaxBytes)
    this.timeBudgetMs = positive(
      'writeQueue.timeBudgetMs',
      options.timeBudgetMs ?? defaultTimeBudgetMs,
    )
  }

  get pendingBytes(): number {
    return this.pendingBytesValue
  }

  noteInput(): void {
    if (!this.disposed) this.inputPending = true
  }

  write(data: string | Uint8Array, options: TerminalBatchedWriteOptions = {}): Promise<T> {
    if (this.disposed) return Promise.reject(this.disposedError())
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    const owned = typeof data === 'string' ? this.encoder.encode(data) : Uint8Array.from(data)
    if (owned.byteLength > this.maxBytes - this.pendingBytesValue)
      return Promise.reject(
        createGhosttyError('writeQueue.write', 'Batched write queue byte limit exceeded', {
          incomingBytes: owned.byteLength,
          maxBytes: this.maxBytes,
          pendingBytes: this.pendingBytesValue,
        }),
      )

    let entry!: WriteEntry<T>
    const result = new Promise<T>((resolve, reject) => {
      const abort = () => this.cancel(entry)
      entry = {
        state: 'queued',
        data: owned,
        bytes: owned.byteLength,
        signal: options.signal,
        abort: options.signal ? abort : undefined,
        resolve,
        reject,
      }
    })
    options.signal?.addEventListener('abort', entry.abort!, { once: true })
    this.entries.push(entry)
    this.pendingBytesValue += owned.byteLength
    if (this.offset === 0 && this.entries.length === 1 && this.inputPending) {
      this.inputPending = false
      this.clearTimer()
      this.process()
      return result
    }
    this.schedule()
    return result
  }

  /** Preserves stream order before synchronous writes, layout changes and worker control commands. */
  flush(): void {
    if (this.disposed) return
    this.flushRequested = true
    this.clearTimer()
    this.process()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    const cause = this.disposedError()
    for (const entry of this.entries) {
      if (entry.state === 'settled' || entry.state === 'cancelled') continue
      this.release(entry)
      entry.state = 'settled'
      entry.reject(cause)
    }
    for (const entry of this.active) {
      if (entry.state === 'settled' || entry.state === 'cancelled') continue
      this.release(entry)
      entry.state = 'settled'
      entry.reject(cause)
    }
    this.active.clear()
    this.entries.length = 0
    this.offset = 0
    this.pendingBytesValue = 0
  }

  private schedule(): void {
    if (
      this.disposed ||
      this.running ||
      this.timer !== undefined ||
      this.offset >= this.entries.length
    )
      return
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      this.process()
    })
  }

  private process(): void {
    if (this.disposed || this.running) return
    this.running = true
    const started = this.clock.now()
    while (this.offset < this.entries.length) {
      const entry = this.entries[this.offset]!
      if (entry.state !== 'queued') {
        this.offset += 1
        continue
      }
      entry.state = 'active'
      this.active.add(entry)
      const data = entry.data!
      try {
        const result = this.execute(data)
        if (result instanceof Promise) {
          void result.then(
            (value) => this.settle(entry, undefined, value),
            (cause: unknown) => this.settle(entry, cause),
          )
        } else {
          this.settle(entry, undefined, result)
        }
      } catch (cause) {
        this.settle(entry, cause)
      }
      this.offset += 1
      if (!this.flushRequested && this.clock.now() - started >= this.timeBudgetMs) break
    }
    this.flushRequested = false
    this.running = false
    this.compact()
    this.schedule()
  }

  private cancel(entry: WriteEntry<T>): void {
    if (entry.state !== 'queued') return
    this.release(entry)
    entry.state = 'cancelled'
    entry.reject(entry.signal?.reason)
  }

  private settle(entry: WriteEntry<T>, cause: unknown, result?: T): void {
    this.active.delete(entry)
    if (entry.state === 'settled' || entry.state === 'cancelled') return
    this.release(entry)
    entry.state = 'settled'
    if (cause !== undefined) {
      entry.reject(cause)
      return
    }
    entry.resolve(result!)
  }

  private release(entry: WriteEntry<T>): void {
    this.pendingBytesValue -= entry.bytes
    entry.data = undefined
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort)
  }

  private compact(): void {
    if (this.offset === 0) return
    if (this.offset < this.entries.length && this.offset < compactThreshold) return
    this.entries.splice(0, this.offset)
    this.offset = 0
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private disposedError() {
    return createGhosttyError('writeQueue.dispose', 'Terminal disposed before batched write parsed')
  }
}
