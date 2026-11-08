export type EventListener<T> = (event: T) => unknown

export type EventErrorSink = (cause: unknown) => unknown

export interface EventSubscription {
  dispose(): void
}

function observeRejection(result: unknown, onRejected: (cause: unknown) => void): void {
  if (result === null) return
  if (typeof result !== 'function' && typeof result !== 'object') return
  const then: unknown = Reflect.get(result, 'then')
  if (typeof then !== 'function') return
  void Promise.resolve({
    then: (resolve: (value: unknown) => void, reject: (cause: unknown) => void) =>
      Reflect.apply(then, result, [resolve, reject]),
  }).catch(onRejected)
}

function ignoreError(): void {}

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

  get hasListeners(): boolean {
    return !this.disposed && this.listeners.size > 0
  }

  readonly emit = (event: T, readCurrent?: () => T): void => {
    if (this.disposed) return
    const listeners = Array.from(this.listeners.values())
    let first = true
    for (const listener of listeners) {
      const current = first || !readCurrent ? event : readCurrent()
      first = false
      this.invoke(listener, current)
    }
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
      observeRejection(result, this.reportError)
    } catch (cause) {
      this.reportError(cause)
    }
  }

  private readonly reportError = (cause: unknown): void => {
    const sink = this.errorSink
    if (!sink) return
    try {
      observeRejection(sink(cause), ignoreError)
    } catch {
      return
    }
  }
}
