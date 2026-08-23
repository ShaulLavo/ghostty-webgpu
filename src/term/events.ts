export type EventListener<T> = (event: T) => unknown

export type EventErrorSink = (cause: unknown) => unknown

export interface EventSubscription {
  dispose(): void
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  if (value === null) return false
  const type = typeof value
  if (type !== 'function' && type !== 'object') return false
  return typeof (value as PromiseLike<void>).then === 'function'
}

function ignoreRejection(result: unknown): void {
  try {
    if (!isPromiseLike(result)) return
    void Promise.resolve(result).catch(() => {})
  } catch {
    return
  }
}

export class EventEmitter<T> {
  private disposed = false
  private errorSink?: EventErrorSink
  private readonly listeners = new Map<symbol, EventListener<T>>()

  constructor(errorSink?: EventErrorSink) {
    if (errorSink !== undefined && typeof errorSink !== 'function') {
      throw new TypeError('EventEmitter error sink must be a function')
    }
    this.errorSink = errorSink
  }

  readonly emit = (event: T): void => {
    if (this.disposed) return
    const listeners = Array.from(this.listeners.values())
    for (const listener of listeners) this.invoke(listener, event)
  }

  subscribe(listener: EventListener<T>): EventSubscription {
    this.ensureActive('subscribe')
    if (typeof listener !== 'function') {
      throw new TypeError('EventEmitter listener must be a function')
    }
    const token = Symbol('event-listener')
    const listeners = this.listeners
    listeners.set(token, listener)
    let subscribed = true
    return Object.freeze({
      dispose: () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(token)
      },
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.errorSink = undefined
  }

  private ensureActive(operation: string): void {
    if (!this.disposed) return
    throw new Error(`EventEmitter.${operation} called after disposal`)
  }

  private invoke(listener: EventListener<T>, event: T): void {
    try {
      const result = listener(event)
      if (!isPromiseLike(result)) return
      void Promise.resolve(result).catch((cause: unknown) => this.reportError(cause))
    } catch (cause) {
      this.reportError(cause)
    }
  }

  private reportError(cause: unknown): void {
    const sink = this.errorSink
    if (!sink) return
    try {
      ignoreRejection(sink(cause))
    } catch {
      return
    }
  }
}
