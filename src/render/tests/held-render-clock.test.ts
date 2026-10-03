import { describe, expect, it } from 'vitest'
import { HeldRenderClock } from '../../../bench/held-render-clock.js'
import { RenderScheduler, type RenderSchedulerClock } from '../scheduler.js'

class FrameClock implements RenderSchedulerClock {
  private nextHandle = 1
  readonly frames = new Map<number, () => void>()
  readonly timers = new Map<number, () => void>()

  requestFrame(callback: () => void): number {
    const handle = this.nextHandle++
    this.frames.set(handle, callback)
    return handle
  }

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  setTimer(callback: () => void): number {
    const handle = this.nextHandle++
    this.timers.set(handle, callback)
    return handle
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }

  drain(): void {
    const callbacks = [...this.frames.values()]
    this.frames.clear()
    for (const callback of callbacks) callback()
  }
}

describe('benchmark held render clock', () => {
  it('keeps parsed output hidden across a queued frame and independent schedules', () => {
    const browser = new FrameClock()
    const clock = new HeldRenderClock(browser)
    const displayed: string[] = []
    let parsed = 'normal'
    const scheduler = new RenderScheduler({ clock, onFrame: () => displayed.push(parsed) })
    scheduler.schedule()
    browser.drain()
    expect(displayed).toEqual(['normal'])

    scheduler.schedule()
    clock.hold()
    parsed = 'held'
    scheduler.schedule()
    browser.drain()
    expect(displayed).toEqual(['normal'])
    expect(scheduler.hasPendingFrame).toBe(true)
    scheduler.schedule()
    browser.drain()
    expect(displayed).toEqual(['normal'])

    clock.release()
    scheduler.schedule()
    browser.drain()
    browser.drain()
    expect(displayed).toEqual(['normal', 'held'])
    expect(scheduler.hasPendingFrame).toBe(false)
    expect(() => clock.release()).toThrow('must be held')
    scheduler.dispose()
    clock.dispose()
  })

  it('holds requests created during a hold and releases before a queued callback', () => {
    const browser = new FrameClock()
    const clock = new HeldRenderClock(browser)
    const delivered: number[] = []
    clock.hold()
    clock.requestFrame(() => delivered.push(1))
    browser.drain()
    expect(delivered).toEqual([])
    clock.requestFrame(() => delivered.push(2))
    clock.release()
    browser.drain()
    browser.drain()
    expect(delivered).toEqual([2, 1])
    clock.dispose()
  })

  it('cancels held and already dispatched callbacks without reviving them', () => {
    const browser = new FrameClock()
    const clock = new HeldRenderClock(browser)
    const delivered: string[] = []
    clock.hold()
    const held = clock.requestFrame(() => delivered.push('held'))
    browser.drain()
    clock.cancelFrame(held)
    const queued = clock.requestFrame(() => delivered.push('queued'))
    const stale = [...browser.frames.values()][0]!
    clock.cancelFrame(queued)
    clock.release()
    stale()
    browser.drain()
    expect(delivered).toEqual([])
    clock.dispose()
  })

  it('disposes held frames and timers even when the underlying callback escaped cancellation', () => {
    const browser = new FrameClock()
    const clock = new HeldRenderClock(browser)
    const delivered: string[] = []
    clock.requestFrame(() => delivered.push('queued'))
    const staleFrame = [...browser.frames.values()][0]!
    clock.hold()
    clock.setTimer(() => delivered.push('timer'), 1)
    const staleTimer = [...browser.timers.values()][0]!
    clock.dispose()
    clock.dispose()
    staleFrame()
    staleTimer()
    browser.drain()
    expect(delivered).toEqual([])
    expect(browser.frames.size).toBe(0)
    expect(browser.timers.size).toBe(0)
    expect(() => clock.release()).toThrow('must be held')
    expect(() => clock.requestFrame(() => {})).toThrow('disposed')
  })

  it('forwards live timers and suppresses canceled timers', () => {
    const browser = new FrameClock()
    const clock = new HeldRenderClock(browser)
    const delivered: number[] = []
    clock.setTimer(() => delivered.push(1), 1)
    const canceled = clock.setTimer(() => delivered.push(2), 1)
    const callbacks = [...browser.timers.values()]
    clock.clearTimer(canceled)
    for (const callback of callbacks) callback()
    clock.dispose()
    expect(delivered).toEqual([1])
  })
})
