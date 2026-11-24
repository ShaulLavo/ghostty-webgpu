import { afterEach, expect, test } from 'vitest'
import type { RenderSchedulerClock } from '../render/shared/scheduler.js'
import { SettledPaint, type SettledPaintTarget } from './settled-paint.js'

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
    failures: [] as unknown[],
    paintPending() {
      if (!this.pending) return false
      log.push(name)
      return true
    },
    fail(cause: unknown) {
      this.failures.push(cause)
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

let nextBatch = 1000
// A page task that wrote only to this terminal.
function solo(paint: SettledPaint, written: SettledPaintTarget): void {
  paint.noteWrite(written, ++nextBatch, 1)
}

test('paints every terminal of a page batch together once all of them have parsed', async () => {
  const { clock } = manualClock()
  const log: string[] = []
  const batches: number[] = []
  const paint = create(clock, batches)
  const first = target('first', log)
  const second = target('second', log)
  paint.noteWrite(first, 1, 2)
  await settled()
  // The sibling's writes may still be queued on its own port.
  expect(log).toEqual([])
  paint.noteWrite(second, 1, 2)
  expect(log).toEqual([])
  await settled()
  expect(log).toEqual(['first', 'second'])
  expect(batches).toHaveLength(1)
})

test('does not paint a terminal early between a parsed write and that write’s marker', async () => {
  const { clock } = manualClock()
  const log: string[] = []
  const paint = create(clock)
  const first = target('first', log)
  const second = target('second', log)
  paint.noteWrite(first, 1, 2)
  paint.noteWrite(second, 1, 2)
  // A later page task's write to the first terminal was parsed before the settle ran.
  paint.hold(first)
  await settled()
  expect(log).toEqual(['second'])
  solo(paint, first)
  await settled()
  expect(log).toEqual(['second', 'first'])
})

test('leaves an incomplete batch to vsync once a display frame has passed', async () => {
  const frames = manualClock()
  const log: string[] = []
  const paint = create(frames.clock)
  const arrived = target('arrived', log)
  const late = target('late', log)
  paint.noteWrite(arrived, 1, 2)
  frames.displayFrame()
  frames.displayFrame()
  paint.noteWrite(late, 1, 2)
  await settled()
  expect(log).toEqual([])
  solo(paint, arrived)
  await settled()
  expect(log).toEqual(['arrived'])
})

test('paints a terminal early at most once per display frame, independently of its siblings', async () => {
  const frames = manualClock()
  const log: string[] = []
  const paint = create(frames.clock)
  const first = target('first', log)
  const second = target('second', log)
  solo(paint, first)
  await settled()
  paint.noteWrite(first, 1, 2)
  paint.noteWrite(second, 1, 2)
  await settled()
  expect(log).toEqual(['first', 'second'])
  frames.displayFrame()
  solo(paint, second)
  await settled()
  // The second terminal settled once last frame, so it may paint early again.
  expect(log).toEqual(['first', 'second', 'second'])
})

test('keeps vsync pacing for a terminal whose output settled more than once per frame', async () => {
  const frames = manualClock()
  const log: string[] = []
  const paint = create(frames.clock)
  const busy = target('busy', log)
  solo(paint, busy)
  await settled()
  solo(paint, busy)
  await settled()
  frames.displayFrame()
  solo(paint, busy)
  await settled()
  expect(log).toEqual(['busy'])
  frames.displayFrame()
  frames.displayFrame()
  solo(paint, busy)
  await settled()
  expect(log).toEqual(['busy', 'busy'])
})

test('does not count a settle without a waiting frame as an early paint', async () => {
  const frames = manualClock()
  const log: string[] = []
  const paint = create(frames.clock)
  const idle = target('idle', log)
  idle.pending = false
  solo(paint, idle)
  await settled()
  idle.pending = true
  solo(paint, idle)
  await settled()
  expect(log).toEqual(['idle'])
})

test('reports a failed paint to its terminal and still paints the rest of the batch', async () => {
  const { clock } = manualClock()
  const log: string[] = []
  const batches: number[] = []
  const paint = create(clock, batches)
  const broken = target('broken', log)
  const cause = new Error('render state read failed')
  broken.paintPending = () => {
    throw cause
  }
  const healthy = target('healthy', log)
  paint.noteWrite(broken, 1, 2)
  paint.noteWrite(healthy, 1, 2)
  await settled()
  expect(broken.failures).toEqual([cause])
  expect(log).toEqual(['healthy'])
  expect(batches).toHaveLength(1)
})

test('forgets a disposed terminal, including in a batch that is still open', async () => {
  const { clock } = manualClock()
  const log: string[] = []
  const paint = create(clock)
  const gone = target('gone', log)
  solo(paint, gone)
  paint.forget(gone)
  await settled()
  expect(log).toEqual([])
  const sibling = target('sibling', log)
  paint.noteWrite(gone, 1, 3)
  paint.forget(gone)
  paint.noteWrite(sibling, 1, 3)
  await settled()
  expect(log).toEqual([])
})
