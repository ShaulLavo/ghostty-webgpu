import type { IDisposable, IEvent } from './types.js'

export type EventErrorSink = (cause: unknown) => unknown

type EventListener<T, U> = (arg1: T, arg2: U) => any

interface EventDelivery<T, U> {
  readonly arg1: T
  readonly arg2: U
  readonly listeners: readonly [symbol, EventListener<T, U>][]
  index: number
}

const noopDisposable: IDisposable = Object.freeze({ dispose() {} })

function isCancellationError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'Canceled' && cause.message === 'Canceled'
}

function reportUnexpectedError(cause: unknown): void {
  if (isCancellationError(cause)) return
  setTimeout(() => {
    if (!cause || typeof cause !== 'object' || !('stack' in cause) || !cause.stack) throw cause
    const message = 'message' in cause ? String(cause.message) : String(cause)
    throw new Error(`${message}\n\n${String(cause.stack)}`)
  }, 0)
}

export class EventEmitter<T, U = void> implements IDisposable {
  private delivery?: EventDelivery<T, U>
  private disposed = false
  private errorSink?: EventErrorSink
  private readonly listeners = new Map<symbol, EventListener<T, U>>()

  readonly event: IEvent<T, U>

  constructor(errorSink?: EventErrorSink) {
    if (errorSink !== undefined && typeof errorSink !== 'function') {
      throw new TypeError('EventEmitter error sink must be a function')
    }
    this.errorSink = errorSink ?? reportUnexpectedError
    this.event = (listener) => this.subscribe(listener)
  }

  emit(arg1: T, arg2?: U): void {
    if (this.disposed) return
    this.drainDelivery()
    const delivery: EventDelivery<T, U> = {
      arg1,
      arg2: arg2 as U,
      index: 0,
      listeners: Array.from(this.listeners.entries()),
    }
    this.delivery = delivery
    this.drainDelivery()
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
      listener(arg1, arg2)
    } catch (cause) {
      this.reportError(cause)
    }
  }

  private drainDelivery(): void {
    const delivery = this.delivery
    if (!delivery) return
    while (delivery.index < delivery.listeners.length) {
      const entry = delivery.listeners[delivery.index]
      delivery.index += 1
      if (!entry) continue
      const [token, listener] = entry
      if (this.listeners.get(token) !== listener) continue
      this.invoke(listener, delivery.arg1, delivery.arg2)
    }
    if (this.delivery === delivery) this.delivery = undefined
  }

  private reportError(cause: unknown): void {
    const sink = this.errorSink
    if (!sink) return
    sink(cause)
  }
}
