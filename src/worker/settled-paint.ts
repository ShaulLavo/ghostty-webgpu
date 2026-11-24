import type { RenderSchedulerClock } from '../render/shared/scheduler.js'

/** A terminal whose waiting frame can be painted now. */
export interface SettledPaintTarget {
  paintPending(): boolean
  /** A paint failure belongs to its terminal; siblings in the batch still paint. */
  fail(cause: unknown): void
}

interface TargetFrames {
  settles: number
  previousSettles: number
  landed: boolean
}

/**
 * A worker that paints at vsync is busy exactly when a page that writes once per frame sends its
 * next write, so that write waits behind the paint. Painting once the queued output is parsed
 * reaches the compositor at the same vsync and leaves the worker free then. Each terminal paints
 * this way at most once per display frame, and not at all while its output settles more than once
 * per frame, so a fast producer keeps plain vsync pacing.
 */
export class SettledPaint {
  private queued = false
  private readonly written = new Set<SettledPaintTarget>()
  private readonly unsettled = new Set<SettledPaintTarget>()
  private readonly frames = new Map<SettledPaintTarget, TargetFrames>()
  private tick?: number
  private readonly channel = new MessageChannel()

  constructor(
    private readonly clock: RenderSchedulerClock,
    private readonly batch: (paint: () => void) => void,
  ) {
    this.channel.port1.onmessage = () => this.settle()
  }

  /** Every write the page posted before this signal has been parsed. */
  noteWrite(target: SettledPaintTarget): void {
    this.unsettled.delete(target)
    this.written.add(target)
    if (this.queued) return
    this.queued = true
    // A posted message runs after the messages already queued for this worker.
    this.channel.port2.postMessage(undefined)
  }

  /**
   * The terminal parsed a write the page may have posted together with others still queued; it
   * paints early only after its next signal, so a settle never shows part of a page task.
   */
  hold(target: SettledPaintTarget): void {
    this.unsettled.add(target)
  }

  forget(target: SettledPaintTarget): void {
    this.written.delete(target)
    this.unsettled.delete(target)
    this.frames.delete(target)
  }

  dispose(): void {
    this.channel.port1.close()
    this.channel.port2.close()
    if (this.tick !== undefined) this.clock.cancelFrame(this.tick)
    this.tick = undefined
  }

  private settle(): void {
    this.queued = false
    const targets = Array.from(this.written)
    this.written.clear()
    this.armTick()
    this.batch(() => {
      for (const target of targets) {
        if (!this.unsettled.has(target)) this.paintSettled(target)
      }
    })
  }

  private paintSettled(target: SettledPaintTarget): void {
    let frames = this.frames.get(target)
    if (!frames) {
      frames = { settles: 0, previousSettles: 0, landed: false }
      this.frames.set(target, frames)
    }
    frames.settles += 1
    if (frames.landed || frames.previousSettles > 1) return
    try {
      frames.landed = target.paintPending()
    } catch (cause) {
      target.fail(cause)
    }
  }

  private armTick(): void {
    if (this.tick !== undefined) return
    this.tick = this.clock.requestFrame(() => {
      this.tick = undefined
      for (const [target, frames] of this.frames) {
        frames.previousSettles = frames.settles
        frames.settles = 0
        frames.landed = false
        if (frames.previousSettles === 0) this.frames.delete(target)
      }
      // One more tick lets a quiet display frame clear the counts.
      if (this.frames.size > 0) this.armTick()
    })
  }
}
