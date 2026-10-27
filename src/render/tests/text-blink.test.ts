import { expect, it } from 'vitest'
import { TextBlink, cellNeedsTextBlink } from '../shared/text-blink.js'
import type { RenderSchedulerClock } from '../shared/scheduler.js'

it('runs at 600 ms only for visible blink content and rejects cancelled callbacks', () => {
  const timers = new Map<number, () => void>()
  let next = 0
  let frames = 0
  const clock: RenderSchedulerClock = {
    cancelFrame() {},
    requestFrame: () => 0,
    clearTimer: (id) => {
      timers.delete(id)
    },
    setTimer(callback, delay) {
      expect(delay).toBe(600)
      timers.set(++next, callback)
      return next
    },
  }
  const blink = new TextBlink(clock, () => {
    frames += 1
  })
  blink.setActive(true)
  expect(timers.size).toBe(0)
  blink.setNeeded(true)
  expect(timers.size).toBe(1)
  const stale = timers.get(next)!
  timers.delete(next)
  stale()
  expect(blink.visible).toBe(false)
  expect(frames).toBe(1)
  blink.setReducedMotion(true)
  expect(blink.visible).toBe(true)
  expect(timers.size).toBe(0)
  expect(frames).toBe(2)
  stale()
  expect(frames).toBe(2)
  blink.setReducedMotion(false)
  expect(timers.size).toBe(1)
  blink.setActive(false)
  expect(timers.size).toBe(0)
  blink.setActive(true)
  blink.setNeeded(false)
  expect(timers.size).toBe(0)
  blink.setNeeded(true)
  blink.dispose()
  expect(timers.size).toBe(0)
})

it('ignores invisible and undecorated blank cells', () => {
  const style = {
    blink: true,
    bold: false,
    faint: false,
    invisible: false,
    inverse: false,
    italic: false,
    overline: false,
    strikethrough: false,
    underline: 0,
  }
  const cell = { x: 0, text: ' ', continuation: false, selected: false, style }
  expect(cellNeedsTextBlink(cell)).toBe(false)
  expect(cellNeedsTextBlink({ ...cell, text: 'A' })).toBe(true)
  expect(cellNeedsTextBlink({ ...cell, style: { ...style, underline: 1 } })).toBe(true)
  expect(cellNeedsTextBlink({ ...cell, text: 'A', style: { ...style, invisible: true } })).toBe(
    false,
  )
})
