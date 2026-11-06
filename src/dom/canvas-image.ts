import type { CanvasImagePublisher } from '../render/shared/displayed-frame.js'

const observeCanvasImage = Symbol.for('ghostty-webgpu.observeCanvasImage')
type Listener = () => unknown

export class CanvasImageRelay {
  private readonly listeners = new Set<{ readonly listener: Listener }>()
  private publisher?: object
  private publication = 0
  private disposed = false

  constructor(private readonly onError: (cause: unknown) => void) {}

  attach(): CanvasImagePublisher {
    const publisher = {}
    if (!this.disposed) this.publisher = publisher
    return {
      notify: (isCurrent) => this.notify(publisher, isCurrent),
      dispose: () => {
        if (this.publisher === publisher) this.publisher = undefined
      },
    }
  }

  subscribe(listener: Listener) {
    if (this.disposed || !this.publisher) return { kind: 'unsupported' } as const
    const subscription = { listener }
    this.listeners.add(subscription)
    return {
      kind: 'subscription' as const,
      dispose: () => this.listeners.delete(subscription),
    }
  }

  dispose(): void {
    this.disposed = true
    this.publisher = undefined
    this.listeners.clear()
  }

  private notify(publisher: object, isCurrent: () => boolean): void {
    if (this.listeners.size === 0) return
    const publication = ++this.publication
    const current = () =>
      !this.disposed &&
      this.publisher === publisher &&
      publication === this.publication &&
      isCurrent()
    for (const subscription of Array.from(this.listeners)) {
      if (!current()) return
      if (!this.listeners.has(subscription)) continue
      this.deliver(subscription.listener)
    }
  }

  private deliver(listener: Listener): void {
    try {
      const result = listener()
      if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return
      void Promise.resolve(result).catch((cause: unknown) => this.report(cause))
    } catch (cause) {
      this.report(cause)
    }
  }

  private report(cause: unknown): void {
    try {
      this.onError(cause)
    } catch {
      // Error hooks cannot turn an accepted source image into a failed draw.
    }
  }
}

export function bindCanvasImage(terminal: object, relay: CanvasImageRelay): void {
  Object.defineProperty(terminal, observeCanvasImage, {
    value: (listener: Listener) => relay.subscribe(listener),
  })
}
