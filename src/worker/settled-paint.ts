import type { RenderSchedulerClock } from '../render/shared/scheduler.js'

/** A terminal whose waiting frame can be painted now. */
export interface SettledPaintTarget {
  paintPending(): boolean
  /** A paint failure belongs to its terminal; siblings in the batch still paint. */
  fail(cause: unknown): void
}

interface OpenBatch {
  readonly size: number
  /** Display frames counted when the batch opened. */
  readonly opened: number
  readonly targets: Set<SettledPaintTarget>
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
  private readonly frames = new Map<SettledPaintTarget, TargetFrames>()
  private readonly batches = new Map<number, OpenBatch>()
  private ticks = 0
  private tick?: number
  private readonly channel = new MessageChannel()

  constructor(
    private readonly clock: RenderSchedulerClock,
    private readonly batch: (paint: () => void) => void,
  ) {
    this.channel.port1.onmessage = () => this.settle()
  }

  /**
   * Notes that `target` has parsed its writes from page batch `batch` of `size` terminals. Ports
   * deliver independently, so a sibling's writes may still be queued; the batch paints once all
   * of its members have arrived, and a batch that never completes leaves them to vsync.
   */
  noteWrite(target: SettledPaintTarget, batch: number, size: number): void {
    let open = this.batches.get(batch)
    if (!open) {
      open = { size, opened: this.ticks, targets: new Set() }
      this.batches.set(batch, open)
      this.armTick()
    }
    open.targets.add(target)
    if (open.targets.size < open.size) return
    this.batches.delete(batch)
    for (const member of open.targets) this.written.add(member)
    if (this.queued) return
    this.queued = true
    // A posted message runs after the messages already queued for this worker.
    this.channel.port2.postMessage(undefined)
  }

  forget(target: SettledPaintTarget): void {
    this.written.delete(target)
    this.frames.delete(target)
    // A batch that lost a member can no longer complete; its others paint at vsync.
    for (const [id, open] of this.batches) {
      if (open.targets.delete(target)) this.batches.delete(id)
    }
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
      for (const target of targets) this.paintSettled(target)
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
      this.ticks += 1
      // A batch open across a whole display frame lost a member; vsync paints the others.
      for (const [id, open] of this.batches) {
        if (this.ticks - open.opened >= 2) this.batches.delete(id)
      }
      for (const [target, frames] of this.frames) {
        frames.previousSettles = frames.settles
        frames.settles = 0
        frames.landed = false
        if (frames.previousSettles === 0) this.frames.delete(target)
      }
      // One more tick lets a quiet display frame clear the counts.
      if (this.frames.size > 0 || this.batches.size > 0) this.armTick()
    })
  }
}
