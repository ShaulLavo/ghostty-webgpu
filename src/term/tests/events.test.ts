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

function callbackResult(target: 'listener' | 'sink', result: unknown) {
  const errors: unknown[] = []
  const failure = new Error('listener failure')
  const emitter = new EventEmitter<void>((cause) => {
    errors.push(cause)
    if (target === 'sink') return result
  })
  emitter.subscribe(() => {
    if (target === 'listener') return result
    throw failure
  })
  return { emitter, errors, failure }
}

async function flushRejections(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

it.each(['listener', 'sink'] as const)(
  'contains a throwing %s then accessor and still delivers later listeners',
  async (target) => {
    const failure = new Error('then getter failed')
    const result = {
      get then(): unknown {
        throw failure
      },
    }
    const observed = callbackResult(target, result)
    const later = vi.fn()
    observed.emitter.subscribe(later)

    expect(() => observed.emitter.emit()).not.toThrow()
    await flushRejections()

    expect(later).toHaveBeenCalledOnce()
    expect(observed.errors).toHaveLength(1)
    expect(observed.errors[0]).toBe(target === 'listener' ? failure : observed.failure)
    observed.emitter.dispose()
  },
)

it.each([
  { target: 'listener', native: false },
  { target: 'listener', native: true },
  { target: 'sink', native: false },
  { target: 'sink', native: true },
] as const)(
  'preserves falsy rejections for $target results with native=$native',
  async (options) => {
    for (const failure of [undefined, null, false, 0, -0, 0n, '', NaN]) {
      const result = options.native
        ? Promise.reject(failure)
        : { then: (_resolve: unknown, reject: (cause: unknown) => void) => reject(failure) }
      const observed = callbackResult(options.target, result)

      observed.emitter.emit()
      await flushRejections()

      expect(observed.errors).toHaveLength(1)
      expect(observed.errors[0]).toBe(options.target === 'listener' ? failure : observed.failure)
      observed.emitter.dispose()
    }
  },
)

it.each(['listener', 'sink'] as const)('contains a throwing %s then method', async (target) => {
  const failure = new Error('then invocation failed')
  const result = {
    then() {
      throw failure
    },
  }
  const observed = callbackResult(target, result)

  expect(() => observed.emitter.emit()).not.toThrow()
  await flushRejections()

  expect(observed.errors).toHaveLength(1)
  expect(observed.errors[0]).toBe(target === 'listener' ? failure : observed.failure)
  observed.emitter.dispose()
})

it.each(['listener', 'sink'] as const)(
  'adopts a %s thenable fulfillment and honors its first settlement',
  async (target) => {
    const failure = new Error('adopted rejection')
    const ignored = new Error('ignored after resolution')
    const result = {
      then(resolve: (value: unknown) => void, reject: (cause: unknown) => void) {
        resolve(Promise.reject(failure))
        reject(ignored)
        throw ignored
      },
    }
    const observed = callbackResult(target, result)

    observed.emitter.emit()
    await flushRejections()

    expect(observed.errors).toHaveLength(1)
    expect(observed.errors[0]).toBe(target === 'listener' ? failure : observed.failure)
    observed.emitter.dispose()
  },
)

it.each(['listener', 'sink'] as const)(
  'preserves %s fulfillment values and ignores then return values',
  async (target) => {
    let reads = 0
    const value = {
      get then() {
        reads += 1
        return undefined
      },
    }
    const result = {
      then(resolve: (value: unknown) => void, reject: (cause: unknown) => void) {
        resolve(value)
        reject(new Error('ignored after fulfillment'))
        return new Error('ignored return value')
      },
    }
    const observed = callbackResult(target, result)

    observed.emitter.emit()
    await flushRejections()

    expect(reads).toBe(2)
    expect(observed.errors).toEqual(target === 'listener' ? [] : [observed.failure])
    observed.emitter.dispose()
  },
)

it('defers callable thenables until after synchronous listener delivery', async () => {
  const calls: string[] = []
  let receiver: unknown
  const result = Object.assign(() => {}, {
    then(resolve: (value: unknown) => void) {
      calls.push('then')
      receiver = this
      resolve(42)
    },
  })
  const emitter = new EventEmitter<void>()
  emitter.subscribe(() => result)
  emitter.subscribe(() => calls.push('later listener'))

  emitter.emit()
  expect(calls).toEqual(['later listener'])
  await flushRejections()

  expect(calls).toEqual(['later listener', 'then'])
  expect(receiver).toBe(result)
  emitter.dispose()
})

it.each([undefined, null, false, 0, '', Symbol('value'), {}, { then: false }])(
  'ignores a non-thenable callback result: %s',
  async (result) => {
    const observed = callbackResult('listener', result)
    observed.emitter.emit()
    await flushRejections()
    expect(observed.errors).toEqual([])
    observed.emitter.dispose()
  },
)
