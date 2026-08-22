import { describe, expect, it } from 'vitest'
import { RenderScheduler, type RenderFrameState, type RenderSchedulerClock } from '../scheduler.js'

class FakeClock implements RenderSchedulerClock {
  private nextHandle = 1
  readonly frames = new Map<number, () => void>()
  readonly timers = new Map<number, () => void>()

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }

  requestFrame(callback: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.frames.set(handle, callback)
    return handle
  }

  setTimer(callback: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.timers.set(handle, callback)
    return handle
  }

  takeFrame(): () => void {
    return this.take(this.frames, 'frame')
  }

  takeTimer(): () => void {
    return this.take(this.timers, 'timer')
  }

  private take(callbacks: Map<number, () => void>, kind: string): () => void {
    const entry = callbacks.entries().next().value
    if (!entry) throw new Error(`No pending ${kind}`)
    const [handle, callback] = entry
    callbacks.delete(handle)
    return callback
  }
}

function createScheduler(clock: FakeClock, frames: RenderFrameState[]): RenderScheduler {
  return new RenderScheduler({
    blinkIntervalMs: 500,
    clock,
    onFrame: (state) => frames.push(state),
  })
}

describe('RenderScheduler', () => {
  it('coalesces write storms and clears pending state before the callback', () => {
    const clock = new FakeClock()
    let scheduler: RenderScheduler
    let pendingInsideFrame = true
    scheduler = new RenderScheduler({
      clock,
      onFrame: () => {
        pendingInsideFrame = scheduler.hasPendingFrame
        scheduler.schedule()
      },
    })

    for (let write = 0; write < 1_000; write += 1) scheduler.schedule()

    expect(clock.frames).toHaveLength(1)
    clock.takeFrame()()
    expect(pendingInsideFrame).toBe(false)
    expect(clock.frames).toHaveLength(1)
  })

  it('keeps unfocused, blink-disabled, and hidden idle free of pending work', () => {
    const clock = new FakeClock()
    const scheduler = createScheduler(clock, [])

    expect(scheduler.hasPendingFrame).toBe(false)
    expect(scheduler.hasPendingTimer).toBe(false)
    scheduler.setCursorBlinkEnabled(true)
    expect(scheduler.hasPendingTimer).toBe(false)
    scheduler.setDocumentVisible(false)
    scheduler.setFocused(true)

    expect(scheduler.hasPendingFrame).toBe(false)
    expect(scheduler.hasPendingTimer).toBe(false)
    expect(clock.frames).toHaveLength(0)
    expect(clock.timers).toHaveLength(0)
  })

  it('schedules exactly one frame for each eligible blink transition', () => {
    const clock = new FakeClock()
    const frames: RenderFrameState[] = []
    const scheduler = createScheduler(clock, frames)
    scheduler.setCursorBlinkEnabled(true)
    scheduler.setFocused(true)
    clock.takeFrame()()

    expect(clock.timers).toHaveLength(1)
    expect(clock.frames).toHaveLength(0)
    clock.takeTimer()()
    expect(clock.frames).toHaveLength(1)
    expect(clock.timers).toHaveLength(1)
    clock.takeFrame()()
    expect(frames.at(-1)?.cursorVisible).toBe(false)

    clock.takeTimer()()
    expect(clock.frames).toHaveLength(1)
    clock.takeFrame()()
    expect(frames.at(-1)?.cursorVisible).toBe(true)
  })

  it('clears blink work and restores the cursor when eligibility ends', () => {
    const clock = new FakeClock()
    const frames: RenderFrameState[] = []
    const scheduler = createScheduler(clock, frames)
    scheduler.setCursorBlinkEnabled(true)
    scheduler.setFocused(true)
    clock.takeFrame()()
    clock.takeTimer()()
    clock.takeFrame()()

    expect(scheduler.cursorVisible).toBe(false)
    scheduler.setFocused(false)
    expect(scheduler.cursorVisible).toBe(true)
    expect(scheduler.hasPendingTimer).toBe(false)
    expect(clock.timers).toHaveLength(0)
    expect(clock.frames).toHaveLength(1)
    clock.takeFrame()()
    expect(frames.at(-1)?.cursorVisible).toBe(true)
  })

  it('makes callbacks captured before disposal inert', () => {
    const clock = new FakeClock()
    const frames: RenderFrameState[] = []
    const scheduler = createScheduler(clock, frames)
    scheduler.setCursorBlinkEnabled(true)
    scheduler.setFocused(true)
    const staleFrame = clock.takeFrame()
    const staleTimer = clock.takeTimer()

    scheduler.dispose()
    staleFrame()
    staleTimer()

    expect(frames).toHaveLength(0)
    expect(clock.frames).toHaveLength(0)
    expect(clock.timers).toHaveLength(0)
    expect(scheduler.hasPendingFrame).toBe(false)
    expect(scheduler.hasPendingTimer).toBe(false)
  })
})
