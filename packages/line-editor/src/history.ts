import { createLineEditorError } from './structured-errors.js'

export interface HistoryStore {
  load(): readonly string[] | Promise<readonly string[]>
  save(entries: readonly string[]): void | Promise<void>
}

export interface HistoryOptions {
  limit?: number
  entries?: readonly string[]
  store?: HistoryStore
}

export class History {
  private values: string[]
  private writes: Promise<void> = Promise.resolve()
  readonly limit: number
  private readonly store: HistoryStore | undefined

  constructor(options: HistoryOptions = {}) {
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw createLineEditorError('INVALID_HISTORY_LIMIT', {
        integer: Number.isSafeInteger(limit),
        nonnegative: limit >= 0,
      })
    }
    this.limit = limit
    this.values = this.limit === 0 ? [] : (options.entries ?? []).slice(-this.limit)
    this.store = options.store
  }

  get entries(): readonly string[] {
    return Object.freeze([...this.values])
  }

  async load(): Promise<void> {
    if (!this.store) return
    const entries = await this.store.load()
    this.values = this.limit === 0 ? [] : entries.slice(-this.limit)
  }

  add(text: string): void {
    if (text.trim() === '' || this.limit === 0 || this.values.at(-1) === text) return
    this.values.push(text)
    this.values = this.values.slice(-this.limit)
    if (!this.store) return
    const entries = this.entries
    const store = this.store
    // A later save must continue after a host persistence failure.
    this.writes = this.writes.catch(() => {}).then(() => store.save(entries))
    // flush() surfaces the failure; editing never leaves an unhandled rejection.
    void this.writes.catch(() => {})
  }

  flush(): Promise<void> {
    return this.writes
  }
}
