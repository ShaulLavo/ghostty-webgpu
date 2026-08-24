export type DeferredTargetOperation<TTarget> = (target: TTarget) => void

export type DeferredTargetCancellation = (reason: unknown) => void

export type DeferredTargetQueueErrorSink = (cause: unknown) => unknown

interface QueuedOperation<TTarget> {
  readonly cancel?: DeferredTargetCancellation
  readonly run: DeferredTargetOperation<TTarget>
}

const noTarget = Symbol('deferred-target-queue.no-target')

function ignoreRejection(result: unknown): void {
  if (!result || typeof (result as PromiseLike<void>).then !== 'function') return
  void Promise.resolve(result).catch(() => {})
}

export class DeferredTargetQueue<TTarget> {
  private bound = false
  private cancelled = false
  private cancellationReason: unknown
  private flushing = false
  private operationIndex = 0
  private readonly operations: QueuedOperation<TTarget>[] = []
  private targetValue: TTarget | typeof noTarget = noTarget

  constructor(private readonly onError: DeferredTargetQueueErrorSink = () => {}) {
    if (typeof onError !== 'function') {
      throw new TypeError('Deferred target queue error sink must be a function')
    }
  }

  get isBound(): boolean {
    return this.bound
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  get pendingCount(): number {
    return this.operations.length - this.operationIndex
  }

  enqueue(
    operation: DeferredTargetOperation<TTarget>,
    cancel?: DeferredTargetCancellation,
  ): boolean {
    if (typeof operation !== 'function') {
      throw new TypeError('Deferred target operation must be a function')
    }
    if (cancel !== undefined && typeof cancel !== 'function') {
      throw new TypeError('Deferred target cancellation must be a function')
    }
    const queued = { cancel, run: operation }
    if (this.cancelled) {
      this.cancelOperation(queued, this.cancellationReason)
      return false
    }
    this.operations.push(queued)
    if (this.bound) this.flush()
    return true
  }

  bind(target: TTarget): boolean {
    if (this.cancelled) return false
    if (this.bound) throw new Error('Deferred target queue is already bound')
    this.bound = true
    this.targetValue = target
    this.flush()
    return true
  }

  flush(): void {
    if (this.cancelled || this.flushing) return
    const target = this.targetValue
    if (target === noTarget) throw new Error('Deferred target queue is not bound')
    this.flushing = true
    try {
      this.drain(target)
    } finally {
      this.flushing = false
      this.discardDrainedOperations()
    }
  }

  cancel(reason?: unknown): void {
    if (this.cancelled) return
    this.cancelled = true
    this.cancellationReason = reason
    this.targetValue = noTarget
    const operations = this.operations.slice(this.operationIndex)
    this.operations.length = 0
    this.operationIndex = 0
    for (const operation of operations) this.cancelOperation(operation, reason)
  }

  private cancelOperation(operation: QueuedOperation<TTarget>, reason: unknown): void {
    if (!operation.cancel) return
    try {
      operation.cancel(reason)
    } catch (cause) {
      this.reportError(cause)
    }
  }

  private drain(target: TTarget): void {
    while (!this.cancelled && this.operationIndex < this.operations.length) {
      const operation = this.operations[this.operationIndex]
      this.operationIndex += 1
      if (!operation) continue
      try {
        operation.run(target)
      } catch (cause) {
        this.reportError(cause)
      }
    }
  }

  private discardDrainedOperations(): void {
    if (this.operationIndex < this.operations.length) return
    this.operations.length = 0
    this.operationIndex = 0
  }

  private reportError(cause: unknown): void {
    try {
      ignoreRejection(this.onError(cause))
    } catch {
      return
    }
  }
}
