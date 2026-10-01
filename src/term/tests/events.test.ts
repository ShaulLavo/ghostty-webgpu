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
