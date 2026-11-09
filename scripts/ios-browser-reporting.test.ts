import { afterEach, expect, test, vi } from 'vitest'
import type { FrameworkObservation } from 'waffle/testing/page-runner/framework-page'
import * as bridge from './ios-browser-page.ts'

// This isolates the bridge's promise ownership. It is not SDK or installed-hook evidence.
function bridgeObservation(overrides: Partial<FrameworkObservation> = {}): FrameworkObservation {
  const observation: FrameworkObservation = {
    signal: new AbortController().signal,
    collected: async () => {},
    taskStarted: async () => {},
    taskUpdate: async () => {},
    caseSettled: async () => {},
    error: async () => {},
    executionFlushed: async () => {},
    testerCleanupSettled: async () => {},
    cleanupResponseReceived: async () => {},
    catcherInstalled() {},
    waitForInitialViewport: async () => ({ permit: 'unit-only', width: 414, height: 896 }),
    waitForRetirement: async () => {},
    ...overrides,
  }
  vi.stubGlobal('document', {})
  vi.stubGlobal(Symbol.for('waffle.framework.observation'), () => observation)
  return observation
}
afterEach(() => vi.unstubAllGlobals())

test('bridge passes a lazy error snapshot without reading the error first', () => {
  let reads = 0
  let factory: Parameters<FrameworkObservation['error']>[0] | undefined
  bridgeObservation({
    error: async (snapshot) => {
      factory = snapshot
    },
  })
  bridge.caughtError(
    {
      get message() {
        reads++
        return 'once'
      },
    },
    'unit',
  )
  expect(reads).toBe(0)
  expect(factory?.()).toEqual({ error: { message: 'once' }, source: 'unit' })
  expect(reads).toBe(1)
})

test('closed reporting skips all further conversion', () => {
  const controller = new AbortController()
  controller.abort('unit-only')
  const error = vi.fn<FrameworkObservation['error']>()
  bridgeObservation({ signal: controller.signal, error })
  bridge.caughtError(
    {
      get message() {
        throw new Error('must not read')
      },
    },
    'unit',
  )
  bridge.taskUpdated([])
  expect(error).not.toHaveBeenCalled()
})

test('reporting rejection is contained at actual lifecycle return owners', async () => {
  bridgeObservation({
    executionFlushed: () => Promise.reject(false),
    testerCleanupSettled: () => Promise.reject(0),
  })
  await expect(bridge.executionFlushed()).resolves.toBeUndefined()
  await expect(bridge.testerCleanupSettled()).resolves.toBeUndefined()
})

test('synchronous reporting faults do not recursively report another error', () => {
  const error = vi.fn<FrameworkObservation['error']>(() => {
    throw 0
  })
  bridgeObservation({ error })
  expect(() => bridge.caughtError('value', 'unit')).not.toThrow()
  expect(error).toHaveBeenCalledTimes(1)
})

test('a lifecycle wait retains its accepted reporting promise', async () => {
  const gate = Promise.withResolvers<void>()
  bridgeObservation({ executionFlushed: () => gate.promise })
  let settled = false
  const operation = bridge.executionFlushed()?.then(() => {
    settled = true
  })
  try {
    await Promise.resolve()
    expect(settled).toBe(false)
  } finally {
    gate.resolve()
    await operation
  }
  expect(settled).toBe(true)
})

test('top cleanup response delivery and retirement are separate awaited operations', async () => {
  const delivered = Promise.withResolvers<void>()
  const retired = Promise.withResolvers<void>()
  const trace: string[] = []
  bridgeObservation({
    cleanupResponseReceived: () => {
      trace.push('record')
      return delivered.promise
    },
    waitForRetirement: () => {
      trace.push('retirement')
      return retired.promise
    },
  })
  const operation = bridge.cleanupResponseReceived()
  try {
    expect(trace).toEqual(['record'])
    delivered.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(trace).toEqual(['record', 'retirement'])
  } finally {
    delivered.resolve()
    retired.resolve()
    await operation
  }
})

test('absent observation remains a no-op', async () => {
  vi.stubGlobal('document', {})
  vi.stubGlobal(Symbol.for('waffle.framework.observation'), undefined)
  expect(bridge.executionFlushed()).toBeUndefined()
  expect(bridge.taskUpdated([])).toBeUndefined()
  await bridge.cleanupResponseReceived()
})

test('conversion preserves every JSON falsy error', () => {
  const snapshots: unknown[] = []
  bridgeObservation({
    error: async (snapshot) => {
      snapshots.push(snapshot())
    },
  })
  for (const error of [0, false, '', null]) bridge.caughtError(error, 'unit')
  expect(snapshots).toEqual([0, false, '', null].map((error) => ({ error, source: 'unit' })))
})

test('an own Error name getter is read once during conversion', () => {
  let reads = 0
  const error = new Error('synthetic')
  // Materialize the native lazy stack before installing the getter under test.
  void error.stack
  Object.defineProperty(error, 'name', {
    get() {
      reads++
      return 'SyntheticError'
    },
    configurable: true,
  })
  const records: unknown[] = []
  bridgeObservation({
    error: async (snapshot) => {
      records.push(snapshot())
    },
  })
  bridge.caughtError(error, 'unit')
  expect(reads).toBe(1)
  expect(records).toHaveLength(1)
})
