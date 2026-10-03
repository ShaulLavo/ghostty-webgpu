import { createGhosttyError } from '../src/core/error.js'
import type { RenderSchedulerClock } from '../src/render/scheduler.js'

type Frame = { callback: () => void; nativeHandle?: number }

// Renderer callbacks already queued before a held write must check the hold at delivery.
export class HeldRenderClock implements RenderSchedulerClock {
  private state: 'open' | 'held' | 'disposed' = 'open'
  private nextHandle = 1
  private readonly frames = new Map<number, Frame>()
  private readonly timers = new Map<number, number>()

  constructor(private readonly clock: RenderSchedulerClock) {}

  hold(): void {
    this.requireState('open')
    this.state = 'held'
  }

  release(): void {
    this.requireState('held')
    this.state = 'open'
    for (const [handle, frame] of this.frames) {
      if (frame.nativeHandle === undefined) this.arm(handle, frame)
    }
  }

  requestFrame(callback: () => void): number {
    this.requireLive()
    const handle = this.nextHandle++
    const frame: Frame = { callback }
    this.frames.set(handle, frame)
    this.arm(handle, frame)
    return handle
  }

  cancelFrame(handle: number): void {
    const frame = this.frames.get(handle)
    this.frames.delete(handle)
    if (frame?.nativeHandle !== undefined) this.clock.cancelFrame(frame.nativeHandle)
  }

  setTimer(callback: () => void, delayMs: number): number {
    this.requireLive()
    const handle = this.nextHandle++
    const nativeHandle = this.clock.setTimer(() => {
      if (!this.timers.delete(handle)) return
      callback()
    }, delayMs)
    this.timers.set(handle, nativeHandle)
    return handle
  }

  clearTimer(handle: number): void {
    const nativeHandle = this.timers.get(handle)
    this.timers.delete(handle)
    if (nativeHandle !== undefined) this.clock.clearTimer(nativeHandle)
  }

  dispose(): void {
    this.state = 'disposed'
    for (const handle of this.frames.keys()) this.cancelFrame(handle)
    for (const handle of this.timers.keys()) this.clearTimer(handle)
  }

  private arm(handle: number, frame: Frame): void {
    frame.nativeHandle = this.clock.requestFrame(() => {
      if (this.frames.get(handle) !== frame) return
      frame.nativeHandle = undefined
      if (this.state === 'held') return
      this.frames.delete(handle)
      frame.callback()
    })
  }

  private requireLive(): void {
    if (this.state !== 'disposed') return
    throw createGhosttyError('held render clock', 'The fixture clock is disposed')
  }

  private requireState(expected: 'open' | 'held'): void {
    if (this.state === expected) return
    throw createGhosttyError('held render clock', `The fixture clock must be ${expected}`)
  }
}
