import { afterEach, expect, test } from 'vitest'
import type { RenderSchedulerClock } from '../render/shared/scheduler.js'
import { SettledPaint } from './settled-paint.js'

function manualClock() {
  const frames = new Map<number, () => void>()
  let next = 0
  const clock: RenderSchedulerClock = {
    requestFrame: (callback) => {
      frames.set(++next, callback)
      return next
    },
    cancelFrame: (handle) => frames.delete(handle),
    setTimer: () => 0,
    clearTimer: () => {},
  }
  return {
    clock,
    displayFrame() {
      const callbacks = Array.from(frames.values())
      frames.clear()
      for (const callback of callbacks) callback()
    },
  }
}

function target(name: string, log: string[]) {
  return {
    pending: true,
    paintPending() {
      if (!this.pending) return false
      log.push(name)
      return true
    },
  }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const created: SettledPaint[] = []
function create(clock: RenderSchedulerClock, batches: number[] = []) {
  const paint = new SettledPaint(clock, (run) => {
    batches.push(1)
    run()
  })
  created.push(paint)
  return paint
}
afterEach(() => {
  for (const paint of created.splice(0)) paint.dispose()
})

test('paints every written terminal in one batch after the queued writes', async () => {
  const { clock } = manualClock()
  const log: string[] = []
  const batches: number[] = []
  const paint = create(clock, batches)
  const first = target('first', log)
  const second = target('second', log)
  paint.noteWrite(first)
  paint.noteWrite(second)
  paint.noteWrite(first)
  expect(log).toEqual([])
  await settled()
  expect(log).toEqual(['first', 'second'])
  expect(batches).toHaveLength(1)
})

test('paints a terminal early at most once per display frame, independently of its siblings', async () => {
  const frames = manualClock()
  const log: string[] = []
  const paint = create(frames.clock)
  const first = target('first', log)
  const second = target('second', log)
  paint.noteWrite(first)
  await settled()
  paint.noteWrite(first)
  paint.noteWrite(second)
  await settled()
  expect(log).toEqual(['first', 'second'])
  frames.displayFrame()
  paint.noteWrite(second)
  await settled()
  // The second terminal settled once last frame, so it may paint early again.
  expect(log).toEqual(['first', 'second', 'second'])
})

test('keeps vsync pacing for a terminal whose output settled more than once per frame', async () => {
  const frames = manualClock()
  const log: string[] = []
  const paint = create(frames.clock)
  const busy = target('busy', log)
  paint.noteWrite(busy)
  await settled()
  paint.noteWrite(busy)
  await settled()
  frames.displayFrame()
  paint.noteWrite(busy)
  await settled()
  expect(log).toEqual(['busy'])
  frames.displayFrame()
  frames.displayFrame()
  paint.noteWrite(busy)
  await settled()
  expect(log).toEqual(['busy', 'busy'])
})

test('does not count a settle without a waiting frame as an early paint', async () => {
  const frames = manualClock()
  const log: string[] = []
  const paint = create(frames.clock)
  const idle = target('idle', log)
  idle.pending = false
  paint.noteWrite(idle)
  await settled()
  idle.pending = true
  paint.noteWrite(idle)
  await settled()
  expect(log).toEqual(['idle'])
})

test('forgets a disposed terminal', async () => {
  const { clock } = manualClock()
  const log: string[] = []
  const paint = create(clock)
  const gone = target('gone', log)
  paint.noteWrite(gone)
  paint.forget(gone)
  await settled()
  expect(log).toEqual([])
})
