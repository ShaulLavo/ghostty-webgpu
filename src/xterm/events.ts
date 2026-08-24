import type { IDisposable, IEvent } from './types.js'

export type EventErrorSink = (cause: unknown) => unknown

type EventListener<T, U> = (arg1: T, arg2: U) => any

const noopDisposable: IDisposable = Object.freeze({ dispose() {} })

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false
  const type = typeof value
  if (type !== 'function' && type !== 'object') return false
  return typeof (value as PromiseLike<unknown>).then === 'function'
}

function ignoreRejection(result: unknown): void {
  try {
    if (!isPromiseLike(result)) return
    void Promise.resolve(result).catch(() => {})
  } catch {
    return
  }
}

export class EventEmitter<T, U = void> implements IDisposable {
  private disposed = false
  private errorSink?: EventErrorSink
  private readonly listeners = new Map<symbol, EventListener<T, U>>()

  readonly event: IEvent<T, U>

  constructor(errorSink?: EventErrorSink) {
    if (errorSink !== undefined && typeof errorSink !== 'function') {
      throw new TypeError('EventEmitter error sink must be a function')
    }
    this.errorSink = errorSink
    this.event = (listener) => this.subscribe(listener)
  }

  emit(arg1: T, arg2?: U): void {
    if (this.disposed) return
    const listeners = Array.from(this.listeners.entries())
    for (const [token, listener] of listeners) {
      if (this.listeners.get(token) !== listener) continue
      this.invoke(listener, arg1, arg2 as U)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.errorSink = undefined
  }

  private subscribe(listener: EventListener<T, U>): IDisposable {
    if (this.disposed) return noopDisposable
    if (typeof listener !== 'function') {
      throw new TypeError('EventEmitter listener must be a function')
    }
    const token = Symbol('event-listener')
    this.listeners.set(token, listener)
    let subscribed = true
    return Object.freeze({
      dispose: () => {
        if (!subscribed) return
        subscribed = false
        this.listeners.delete(token)
      },
    })
  }

  private invoke(listener: EventListener<T, U>, arg1: T, arg2: U): void {
    try {
      const result = listener(arg1, arg2)
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
