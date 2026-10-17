import { insideAnimationFrame } from '../render/shared/config.js'
import type { TerminalOutputTiming } from './types.js'

const defaultQuietMs = 100
const defaultInputWindowMs = 2_000

export interface OutputTimingLimits {
  readonly quietMs: number
  readonly inputWindowMs: number
}

/** Validates the embedder's `outputTiming` options once, when the terminal is created. */
export function outputTimingLimits(
  options: { readonly quietMs?: number; readonly inputWindowMs?: number } | undefined,
): OutputTimingLimits {
  return {
    quietMs: positiveMilliseconds('outputTiming.quietMs', options?.quietMs ?? defaultQuietMs),
    inputWindowMs: positiveMilliseconds(
      'outputTiming.inputWindowMs',
      options?.inputWindowMs ?? defaultInputWindowMs,
    ),
  }
}

function positiveMilliseconds(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be greater than zero`)
}

export interface OutputTimingClock {
  now(): number
  setTimer(callback: () => void, delayMs: number): number
  clearTimer(handle: number): void
  requestFrame(callback: () => void): void
  /** Runs after the current page update finishes. */
  postTask(callback: () => void): void
  dispose(): void
}

export interface OutputTimingOptions {
  readonly clock: OutputTimingClock
  readonly limits: OutputTimingLimits
  /** False when frames are drawn on another thread, whose page updates this window cannot see. */
  readonly measuresPresentation: boolean
  pendingFrame(): boolean
  /** False while the page is hidden; a quiet burst then waits for `resume`. */
  visible(): boolean
  describe(): Pick<TerminalOutputTiming, 'desynchronized' | 'presentation' | 'rendererBackend'>
  emit(timing: TerminalOutputTiming): void
}

interface Burst {
  readonly inputAt?: number
  readonly firstOutputAt: number
  lastOutputAt: number
  writes: number
  sequence: number
  drawnAt?: number
  presentedAt?: number
  presenting: boolean
  quiet: boolean
  hidden: boolean
  rechecks: number
}

// A visible burst waiting on a draw that never comes (failed renderer) ends after this many quiet periods.
const maximumRechecks = 2

export class OutputTimingTracker {
  private burst?: Burst
  private lastInputAt?: number
  private sequence = 0
  private appliedSequence = 0
  private timer?: number
  private disposed = false
  private readonly quietMs: number

  constructor(private readonly options: OutputTimingOptions) {
    this.quietMs = options.limits.quietMs
  }

  input(): void {
    if (this.disposed) return
    this.lastInputAt = this.options.clock.now()
  }

  /** Records a write and returns its sequence for `applied`. */
  output(): number {
    const at = this.options.clock.now()
    if (this.burst?.quiet) this.finish()
    const sequence = ++this.sequence
    let burst = this.burst
    if (!burst) {
      const input = this.lastInputAt
      burst = {
        inputAt:
          input !== undefined && at - input <= this.options.limits.inputWindowMs
            ? input
            : undefined,
        firstOutputAt: at,
        lastOutputAt: at,
        writes: 0,
        sequence,
        presenting: false,
        quiet: false,
        hidden: false,
        rechecks: 0,
      }
      this.burst = burst
      this.lastInputAt = undefined
    }
    burst.lastOutputAt = at
    burst.writes += 1
    burst.sequence = sequence
    burst.drawnAt = undefined
    burst.presentedAt = undefined
    burst.presenting = false
    this.armTimer(this.quietMs)
    return sequence
  }

  /** The native terminal has taken the write, so frames drawn from now on hold it. */
  applied(sequence: number): void {
    if (sequence > this.appliedSequence) this.appliedSequence = sequence
  }

  drawn(): void {
    const burst = this.burst
    if (!burst || burst.drawnAt !== undefined) return
    if (this.appliedSequence < burst.sequence) return
    const clock = this.options.clock
    burst.drawnAt = clock.now()
    if (!this.options.measuresPresentation) {
      this.finishIfSettled()
      return
    }
    burst.presenting = true
    const sequence = burst.sequence
    const settle = () => clock.postTask(() => this.presented(burst, sequence))
    // Drawing inside an animation frame joins that frame's update; otherwise the next one carries it.
    if (insideAnimationFrame()) settle()
    else clock.requestFrame(settle)
  }

  /** The page is visible again, so a burst that waited while hidden can be drawn and finish. */
  resume(): void {
    const burst = this.burst
    if (!burst?.quiet || this.disposed) return
    burst.rechecks = 0
    this.armTimer(this.quietMs)
  }

  dispose(): void {
    this.disposed = true
    this.burst = undefined
    this.clearTimer()
    this.options.clock.dispose()
  }

  private presented(burst: Burst, sequence: number): void {
    if (this.burst !== burst || burst.sequence !== sequence || !burst.presenting) return
    burst.presentedAt = this.options.clock.now()
    burst.presenting = false
    this.finishIfSettled()
  }

  private armTimer(delayMs: number): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = this.options.clock.setTimer(() => this.checkQuiet(), delayMs)
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    this.options.clock.clearTimer(this.timer)
    this.timer = undefined
  }

  private checkQuiet(): void {
    this.timer = undefined
    const burst = this.burst
    if (!burst || this.disposed) return
    const remaining = burst.lastOutputAt + this.quietMs - this.options.clock.now()
    if (remaining > 0) {
      this.armTimer(remaining)
      return
    }
    burst.quiet = true
    if (this.finishIfSettled()) return
    burst.hidden = !this.options.visible()
    if (burst.hidden) return
    burst.rechecks += 1
    if (burst.rechecks > maximumRechecks) {
      this.finish()
      return
    }
    this.armTimer(this.quietMs)
  }

  private finishIfSettled(): boolean {
    const burst = this.burst
    if (!burst?.quiet) return false
    if (burst.presenting) return false
    if (burst.drawnAt === undefined && this.awaitingDraw(burst)) return false
    this.finish()
    return true
  }

  private awaitingDraw(burst: Burst): boolean {
    return (
      !this.options.visible() ||
      this.appliedSequence < burst.sequence ||
      this.options.pendingFrame()
    )
  }

  private finish(): void {
    const burst = this.burst
    if (!burst) return
    this.burst = undefined
    this.clearTimer()
    const presented = burst.presenting ? undefined : burst.presentedAt
    this.options.emit(
      Object.freeze({
        inputAt: burst.inputAt,
        firstOutputAt: burst.firstOutputAt,
        lastOutputAt: burst.lastOutputAt,
        drawnAt: burst.drawnAt,
        presentedAt: presented,
        writes: burst.writes,
        hidden: burst.drawnAt === undefined && burst.hidden,
        ...this.options.describe(),
      }),
    )
  }
}

export function browserOutputTimingClock(): OutputTimingClock {
  const channel = new MessageChannel()
  const tasks: (() => void)[] = []
  let disposed = false
  channel.port1.onmessage = () => tasks.shift()?.()
  return {
    now: () => performance.now(),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle),
    requestFrame: (callback) => window.requestAnimationFrame(() => callback()),
    postTask: (callback) => {
      if (disposed) return
      tasks.push(callback)
      channel.port2.postMessage(undefined)
    },
    dispose: () => {
      disposed = true
      tasks.length = 0
      channel.port1.close()
      channel.port2.close()
    },
  }
}
