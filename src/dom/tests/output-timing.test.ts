import { describe, expect, it } from 'vitest'
import {
  outputTimingLimits,
  OutputTimingTracker,
  type OutputTimingClock,
} from '../output-timing.js'
import type { TerminalOutputTiming } from '../types.js'

class FakeClock implements OutputTimingClock {
  time = 0
  private nextHandle = 1
  readonly timers = new Map<number, { at: number; callback: () => void }>()
  readonly frames: (() => void)[] = []
  readonly tasks: (() => void)[] = []
  disposed = false

  now(): number {
    return this.time
  }
  setTimer(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++
    this.timers.set(handle, { at: this.time + delayMs, callback })
    return handle
  }
  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }
  requestFrame(callback: () => void): void {
    this.frames.push(callback)
  }
  postTask(callback: () => void): void {
    this.tasks.push(callback)
  }
  dispose(): void {
    this.disposed = true
  }

  advance(to: number): void {
    this.time = to
    for (const [handle, timer] of Array.from(this.timers)) {
      if (timer.at > to) continue
      this.timers.delete(handle)
      timer.callback()
    }
  }
  runFrame(at: number): void {
    this.time = at
    for (const callback of this.frames.splice(0)) callback()
  }
  runTasks(at: number): void {
    this.time = at
    for (const callback of this.tasks.splice(0)) callback()
  }
}

function tracker(
  clock: FakeClock,
  options: { pending?: () => boolean; presentation?: boolean; visible?: () => boolean },
) {
  const emitted: TerminalOutputTiming[] = []
  const timing = new OutputTimingTracker({
    clock,
    limits: { quietMs: 50, inputWindowMs: 500 },
    measuresPresentation: options.presentation ?? true,
    pendingFrame: options.pending ?? (() => false),
    visible: options.visible ?? (() => true),
    describe: () => ({ desynchronized: false, presentation: 'frame', rendererBackend: 'webgl2' }),
    emit: (event) => emitted.push(event),
  })
  return { timing, emitted }
}

function write(clock: FakeClock, timing: OutputTimingTracker, at: number): void {
  clock.time = at
  timing.applied(timing.output())
}

describe('OutputTimingTracker', () => {
  it('reports one burst with ordered input, output, draw and presentation times', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, {})

    clock.time = 1
    timing.input()
    write(clock, timing, 4)
    write(clock, timing, 10)
    clock.time = 12
    timing.drawn()
    clock.runFrame(16)
    clock.runTasks(18)
    expect(emitted).toEqual([])
    clock.advance(60)

    expect(emitted).toEqual([
      {
        inputAt: 1,
        firstOutputAt: 4,
        lastOutputAt: 10,
        drawnAt: 12,
        presentedAt: 18,
        writes: 2,
        hidden: false,
        desynchronized: false,
        presentation: 'frame',
        rendererBackend: 'webgl2',
      },
    ])
  })

  it('times the frame holding the last write, ignoring earlier draws', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, {})

    write(clock, timing, 0)
    clock.time = 2
    timing.drawn()
    write(clock, timing, 20)
    clock.runFrame(21)
    clock.runTasks(22)
    clock.time = 30
    timing.drawn()
    clock.runFrame(33)
    clock.runTasks(34)
    clock.advance(80)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ drawnAt: 30, presentedAt: 34, writes: 2 })
  })

  it('waits for a pending frame after the output goes quiet', () => {
    const clock = new FakeClock()
    let pending = true
    const { timing, emitted } = tracker(clock, { pending: () => pending })

    write(clock, timing, 0)
    clock.advance(60)
    expect(emitted).toEqual([])
    pending = false
    clock.time = 70
    timing.drawn()
    clock.runFrame(75)
    clock.runTasks(76)

    expect(emitted[0]).toMatchObject({ drawnAt: 70, presentedAt: 76 })
  })

  it('ends a burst without draw times when nothing draws it', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, {})

    write(clock, timing, 0)
    clock.advance(60)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.drawnAt).toBeUndefined()
    expect(emitted[0]?.presentedAt).toBeUndefined()
  })

  it('ignores draws until the write is applied', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, { presentation: false })

    const sequence = timing.output()
    clock.time = 5
    timing.drawn()
    timing.applied(sequence)
    clock.time = 9
    timing.drawn()
    clock.advance(60)

    expect(emitted[0]).toMatchObject({ drawnAt: 9 })
    expect(emitted[0]?.presentedAt).toBeUndefined()
  })

  it('starts a new burst, with the newer input, once output has paused', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, {})

    write(clock, timing, 0)
    clock.advance(60)
    clock.time = 100
    timing.input()
    write(clock, timing, 103)
    clock.advance(200)

    expect(emitted).toHaveLength(2)
    expect(emitted[0]?.inputAt).toBeUndefined()
    expect(emitted[1]).toMatchObject({ inputAt: 100, firstOutputAt: 103 })
  })

  it('gives up on a frame that never comes', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, { pending: () => true })

    write(clock, timing, 0)
    clock.advance(60)
    clock.advance(120)
    expect(emitted).toEqual([])
    clock.advance(180)
    clock.advance(240)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.drawnAt).toBeUndefined()
  })

  it('stops its timer and clock on dispose', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, {})

    write(clock, timing, 0)
    timing.dispose()
    clock.advance(100)

    expect(emitted).toEqual([])
    expect(clock.timers.size).toBe(0)
    expect(clock.disposed).toBe(true)
  })

  it('forgets input older than the input window', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, {})

    clock.time = 0
    timing.input()
    write(clock, timing, 600)
    clock.advance(700)

    expect(emitted[0]?.inputAt).toBeUndefined()
  })

  it('waits while the page is hidden and finishes once it is drawn after showing again', () => {
    const clock = new FakeClock()
    let visible = false
    const { timing, emitted } = tracker(clock, { visible: () => visible })

    write(clock, timing, 0)
    clock.advance(60)
    clock.advance(1_000)
    expect(emitted).toEqual([])
    expect(clock.timers.size).toBe(0)

    visible = true
    timing.resume()
    clock.time = 1_005
    timing.drawn()
    clock.runFrame(1_010)
    clock.runTasks(1_011)
    clock.advance(1_100)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ drawnAt: 1_005, presentedAt: 1_011, hidden: false })
  })

  it('marks a burst replaced while hidden as hidden, not unchanged', () => {
    const clock = new FakeClock()
    const { timing, emitted } = tracker(clock, { visible: () => false })

    write(clock, timing, 0)
    clock.advance(60)
    write(clock, timing, 100)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ hidden: true })
    expect(emitted[0]?.drawnAt).toBeUndefined()
  })

  it('rejects limits that are not positive', () => {
    expect(() => outputTimingLimits({ quietMs: 0 })).toThrow(RangeError)
    expect(() => outputTimingLimits({ inputWindowMs: Number.NaN })).toThrow(RangeError)
    expect(outputTimingLimits(undefined)).toEqual({ quietMs: 100, inputWindowMs: 2_000 })
  })
})
