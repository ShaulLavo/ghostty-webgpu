import type { TerminalInputData } from '../term/types.js'

export interface XtermWriteQueueOptions<TTarget> {
  readonly consume: (target: TTarget, data: TerminalInputData) => void
  readonly maxPendingData?: number
  readonly now?: () => number
  readonly onWriteParsed: () => void
  readonly scheduleTask?: (callback: () => void) => void
  readonly sliceMilliseconds?: number
}

interface QueuedWrite {
  readonly callback?: () => void
  data: TerminalInputData
}

interface WriteBatch {
  index: number
  readonly writes: QueuedWrite[]
}

type BatchResult = 'abandoned' | 'blocked' | 'complete' | 'yielded'

const defaultMaxPendingData = 50_000_000
const defaultSliceMilliseconds = 12
const noTarget = Symbol('xterm-write-queue.no-target')

function defaultNow(): number {
  return performance.now()
}

function defaultScheduleTask(callback: () => void): void {
  setTimeout(callback)
}

function snapshotInput(data: TerminalInputData): TerminalInputData {
  if (typeof data === 'string') return data
  return Uint8Array.from(data)
}

function validateData(data: TerminalInputData): void {
  if (typeof data === 'string' || data instanceof Uint8Array) return
  throw new TypeError('Terminal write data must be a string or Uint8Array')
}

function validateCallback(callback: (() => void) | undefined): void {
  if (callback === undefined || typeof callback === 'function') return
  throw new TypeError('Terminal write callback must be a function')
}

export class XtermWriteQueue<TTarget> {
  private abandoned = false
  private activeBatch?: WriteBatch
  private readonly consume: (target: TTarget, data: TerminalInputData) => void
  private readonly dueBatches: WriteBatch[] = []
  private drainScheduled = false
  private draining = false
  private userInputPending = false
  private readonly maxPendingData: number
  private readonly now: () => number
  private readonly onWriteParsed: () => void
  private paused = false
  private parsedEventDepth = 0
  private pendingData = 0
  private processingBatch?: WriteBatch
  private readonly scheduleTask: (callback: () => void) => void
  private sliceScheduled = false
  private readonly sliceMilliseconds: number
  private stranded = false
  private targetValue: TTarget | typeof noTarget = noTarget

  constructor(options: XtermWriteQueueOptions<TTarget>) {
    this.consume = options.consume
    this.maxPendingData = options.maxPendingData ?? defaultMaxPendingData
    this.now = options.now ?? defaultNow
    this.onWriteParsed = options.onWriteParsed
    this.scheduleTask = options.scheduleTask ?? defaultScheduleTask
    this.sliceMilliseconds = options.sliceMilliseconds ?? defaultSliceMilliseconds
    this.validateOptions()
  }

  get isAbandoned(): boolean {
    return this.abandoned
  }

  get isBound(): boolean {
    return this.targetValue !== noTarget
  }

  get isPaused(): boolean {
    return this.paused
  }

  get isStranded(): boolean {
    return this.stranded
  }

  get pendingCount(): number {
    const active = this.activeBatch?.writes.length ?? 0
    return (
      active +
      this.dueBatches.reduce((count, batch) => {
        return count + batch.writes.length - batch.index
      }, 0)
    )
  }

  abandon(): void {
    if (this.abandoned) return
    this.abandoned = true
    this.activeBatch = undefined
    this.dueBatches.length = 0
    this.pendingData = 0
    this.targetValue = noTarget
  }

  bind(target: TTarget): void {
    if (this.abandoned) return
    if (this.targetValue !== noTarget) throw new Error('Xterm write queue is already bound')
    this.targetValue = target
    this.scheduleDrain()
  }

  handleUserInput(): void {
    if (this.abandoned || this.stranded) return
    this.userInputPending = true
  }

  pause(): void {
    if (this.abandoned) return
    this.paused = true
  }

  resume(): void {
    if (this.abandoned || !this.paused) return
    this.paused = false
    this.scheduleDrain()
  }

  write(data: TerminalInputData, callback?: () => void): void {
    validateData(data)
    validateCallback(callback)
    if (this.abandoned) return
    this.verifyWatermark()
    const write = { callback, data }
    this.pendingData += data.length
    if (this.stranded) {
      this.appendToStrandedBatch(write)
      return
    }
    if (this.processingBatch) {
      this.appendToDrainingBatch(write)
      return
    }
    if (this.activeBatch) {
      this.activeBatch.writes.push(write)
      return
    }
    if (this.appendToDueBatch(write)) return
    if (this.userInputPending) {
      this.enqueueUserInputWrite(write)
      return
    }
    this.enqueueScheduledWrite(write)
  }

  writeln(data: TerminalInputData, callback?: () => void): void {
    this.write(data)
    this.write('\r\n', callback)
  }

  private appendToDrainingBatch(write: QueuedWrite): void {
    const batch = this.processingBatch
    if (!batch) throw new Error('Xterm write queue lost its draining batch')
    batch.writes.push(write)
  }

  private appendToDueBatch(write: QueuedWrite): boolean {
    const batch = this.dueBatches[this.dueBatches.length - 1]
    if (!batch) return false
    batch.writes.push(write)
    return true
  }

  private appendToStrandedBatch(write: QueuedWrite): void {
    const batch = this.dueBatches[0]
    if (!batch) throw new Error('Xterm write queue lost its stranded batch')
    batch.writes.push(write)
  }

  private canDeliver(): boolean {
    return !this.paused && this.targetValue !== noTarget
  }

  private completeBatch(batch: WriteBatch): void {
    if (this.dueBatches[0] !== batch) {
      throw new Error('Xterm write queue completed batches out of order')
    }
    this.dueBatches.shift()
    if (this.dueBatches.length === 0 && !this.activeBatch) this.pendingData = 0
    this.emitWriteParsed()
  }

  private consumeBatch(batch: WriteBatch): BatchResult {
    const startedAt = this.now()
    while (batch.index < batch.writes.length) {
      if (!this.canDeliver()) {
        this.snapshotBatchRemainder(batch)
        return 'blocked'
      }
      this.consumeWrite(batch.writes[batch.index]!)
      if (this.abandoned) return 'abandoned'
      batch.index += 1
      if (!this.shouldYield(startedAt, batch)) continue
      this.scheduleSlice(batch)
      this.emitWriteParsed()
      return 'yielded'
    }
    return 'complete'
  }

  private consumeWrite(write: QueuedWrite): void {
    this.consumeTarget(write.data)
    write.callback?.()
    if (this.abandoned) return
    this.pendingData -= write.data.length
  }

  private drainDueBatches(): void {
    if (!this.canStartDrain()) return
    this.draining = true
    try {
      this.drainLoop()
    } catch (cause) {
      this.stranded = true
      this.processingBatch = undefined
      throw cause
    } finally {
      this.draining = false
    }
  }

  private drainLoop(): void {
    while (this.dueBatches.length > 0) {
      const batch = this.dueBatches[0]!
      this.processingBatch = batch
      const result = this.consumeBatch(batch)
      if (result !== 'complete') {
        this.processingBatch = undefined
        return
      }
      this.processingBatch = undefined
      this.completeBatch(batch)
      if (this.abandoned || this.stranded || this.sliceScheduled || !this.canDeliver()) return
    }
  }

  private canStartDrain(): boolean {
    if (
      this.abandoned ||
      this.stranded ||
      this.draining ||
      this.drainScheduled ||
      this.sliceScheduled
    ) {
      return false
    }
    if (!this.canDeliver()) return false
    return this.dueBatches.length > 0
  }

  private enqueueScheduledWrite(write: QueuedWrite): void {
    const batch = { index: 0, writes: [write] }
    this.activeBatch = batch
    this.scheduleTask(() => this.makeBatchDue(batch))
  }

  private enqueueUserInputWrite(write: QueuedWrite): void {
    this.userInputPending = false
    const data = this.canDeliver() ? write.data : snapshotInput(write.data)
    const batch = { index: 0, writes: [{ ...write, data }] }
    this.dueBatches.push(batch)
    if (this.parsedEventDepth > 0) {
      this.drainParsedUserInputBatch(batch)
      return
    }
    this.drainDueBatches()
  }

  private drainParsedUserInputBatch(batch: WriteBatch): void {
    this.processingBatch = batch
    let result: BatchResult
    try {
      result = this.consumeBatch(batch)
    } catch (cause) {
      this.stranded = true
      throw cause
    } finally {
      this.processingBatch = undefined
    }
    if (result !== 'complete') return
    this.completeBatch(batch)
  }

  private emitWriteParsed(): void {
    this.parsedEventDepth += 1
    try {
      this.onWriteParsed()
    } finally {
      this.parsedEventDepth -= 1
    }
  }

  private makeBatchDue(batch: WriteBatch): void {
    if (this.abandoned || this.stranded) return
    if (this.activeBatch !== batch) return
    this.activeBatch = undefined
    if (!this.canDeliver()) this.snapshotBatchRemainder(batch)
    this.dueBatches.push(batch)
    this.drainDueBatches()
  }

  private scheduleSlice(batch: WriteBatch): void {
    if (this.sliceScheduled) return
    this.sliceScheduled = true
    this.scheduleTask(() => {
      this.sliceScheduled = false
      if (this.abandoned || this.stranded) return
      if (!this.canDeliver()) this.snapshotBatchRemainder(batch)
      this.drainDueBatches()
    })
  }

  private snapshotBatchRemainder(batch: WriteBatch): void {
    for (let index = batch.index; index < batch.writes.length; index += 1) {
      const write = batch.writes[index]
      if (write) write.data = snapshotInput(write.data)
    }
  }

  private scheduleDrain(): void {
    if (!this.canStartDrain()) return
    this.drainScheduled = true
    this.scheduleTask(() => {
      this.drainScheduled = false
      this.drainDueBatches()
    })
  }

  private consumeTarget(data: TerminalInputData): void {
    const target = this.targetValue
    if (target === noTarget) throw new Error('Xterm write queue has no bound target')
    this.consume(target, data)
  }

  private shouldYield(startedAt: number, batch: WriteBatch): boolean {
    if (batch.index >= batch.writes.length) return false
    return this.now() - startedAt >= this.sliceMilliseconds
  }

  private validateOptions(): void {
    if (typeof this.consume !== 'function') throw new TypeError('consume must be a function')
    if (typeof this.onWriteParsed !== 'function') {
      throw new TypeError('onWriteParsed must be a function')
    }
    if (typeof this.scheduleTask !== 'function') {
      throw new TypeError('scheduleTask must be a function')
    }
    if (typeof this.now !== 'function') throw new TypeError('now must be a function')
    if (this.maxPendingData < 0) throw new RangeError('maxPendingData cannot be negative')
    if (this.sliceMilliseconds < 0) {
      throw new RangeError('sliceMilliseconds cannot be negative')
    }
  }

  private verifyWatermark(): void {
    if (this.pendingData <= this.maxPendingData) return
    throw new Error('write data discarded, use flow control to avoid losing data')
  }
}
