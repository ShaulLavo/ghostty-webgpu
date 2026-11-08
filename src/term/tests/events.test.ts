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

it.each(['listener', 'sink'] as const)(
  'reads a %s then accessor once and calls the captured method with its receiver',
  async (target) => {
    const failure = new Error('original rejection')
    const secondRead = new Error('second getter read')
    const errors: unknown[] = []
    let reads = 0
    let receiver: unknown
    const result = {
      get then() {
        reads += 1
        if (reads > 1) throw secondRead
        return function (this: unknown, _resolve: unknown, reject: (cause: unknown) => void) {
          receiver = this
          reject(failure)
        }
      },
    }
    const emitter = new EventEmitter<void>((cause) => {
      errors.push(cause)
      if (target === 'sink') return result
    })
    emitter.subscribe(() => {
      if (target === 'listener') return result
      throw failure
    })

    emitter.emit()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect.soft(reads).toBe(1)
    expect.soft(receiver).toBe(result)
    expect(errors).toEqual([failure])
    emitter.dispose()
  },
)
