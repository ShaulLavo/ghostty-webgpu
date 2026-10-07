import { expect, it, vi } from 'vitest'
import { EventEmitter } from '../events.js'

it('tracks live subscriptions so frame producers can skip unobserved work', () => {
  const emitter = new EventEmitter<readonly number[]>()
  expect(emitter.hasListeners).toBe(false)
  const first = vi.fn()
  const second = vi.fn()
  const firstSubscription = emitter.subscribe(first)
  const secondSubscription = emitter.subscribe(second)
  expect(emitter.hasListeners).toBe(true)
  emitter.emit([0, 2])
  expect(first).toHaveBeenCalledWith([0, 2])
  expect(second).toHaveBeenCalledWith([0, 2])
  firstSubscription.dispose()
  expect(emitter.hasListeners).toBe(true)
  secondSubscription.dispose()
  secondSubscription.dispose()
  expect(emitter.hasListeners).toBe(false)
  emitter.dispose()
})

it.each([
  { refresh: false, expected: [2, 1] },
  { refresh: true, expected: [2, 2] },
])('refreshes state snapshots while preserving effect delivery: %j', ({ refresh, expected }) => {
  const emitter = new EventEmitter<number>()
  let state = 1
  const readCurrent = refresh ? () => state : undefined
  const observed: number[] = []
  emitter.subscribe(() => {
    if (state === 2) return
    state = 2
    emitter.emit(state, readCurrent)
  })
  emitter.subscribe((event) => observed.push(event))
  emitter.emit(state, readCurrent)
  expect(observed).toEqual(expected)
  emitter.dispose()
})

it('clears listener presence on disposal and stops frame delivery', () => {
  const emitter = new EventEmitter<readonly number[]>()
  const listener = vi.fn()
  const subscription = emitter.subscribe(listener)
  emitter.dispose()
  expect(emitter.hasListeners).toBe(false)
  emitter.emit([1])
  subscription.dispose()
  expect(listener).not.toHaveBeenCalled()
})
