import { expect, test } from 'vitest'
import { until } from './ios-browser-reporting-realm.ts'
import { getFrameworkObservation } from 'waffle/testing/page-runner/framework-page'

type ErrorTrace = { kind: string; source?: unknown; payload?: unknown; receiver?: boolean }
const trace: ErrorTrace[] = []
Reflect.set(globalThis, '__reportingErrorTrace', trace)
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
function rawError(source: string) {
  return Object.defineProperties(
    {},
    Object.fromEntries(
      ['name', 'message', 'stack'].map((key) => [
        key,
        {
          get() {
            trace.push({ kind: `read:${source}:${key}` })
            return `${source}:${key}`
          },
          enumerable: true,
        },
      ]),
    ),
  )
}
function testerEndpoint() {
  const endpoint: unknown = Reflect.get(globalThis, Symbol.for('ghostty.synthetic.tester-errors'))
  if (
    !object(endpoint) ||
    typeof endpoint.unhandledError !== 'function' ||
    !object(endpoint.client)
  )
    throw new Error('Actual installed tester endpoint missing')
  return { unhandledError: endpoint.unhandledError, client: endpoint.client }
}
let observing = false
function observeOriginalErrors(): void {
  if (observing) return
  const client = testerEndpoint().client
  if (!object(client.rpc)) throw new Error('Actual installed client RPC missing')
  const original = client.rpc
  const rpc = new Proxy(original, {
    get(target, key, receiver) {
      if (key !== 'onUnhandledError') return Reflect.get(target, key, receiver)
      return function (this: unknown, payload: unknown, source: unknown) {
        trace.push({ kind: 'rpc', source, payload, receiver: this === rpc })
        return Promise.reject(0)
      }
    },
  })
  client.rpc = rpc
  observing = true
}
async function capacityBurst(): Promise<void> {
  observeOriginalErrors()
  const endpoint = testerEndpoint()
  const results = Array.from({ length: 65 }, (_, index) =>
    Reflect.apply(endpoint.unhandledError, undefined, [
      { name: 'SyntheticError', message: `capacity ${index}`, stack: 'synthetic' },
      'Synthetic capacity error',
    ]),
  )
  await Promise.all(results)
  expect(trace.filter((item) => item.source === 'Synthetic capacity error')).toHaveLength(65)
  trace.push({ kind: 'capacity-refusal', payload: window.__waffleFramework?.snapshot() })
}
test('reporting refusal remains infrastructure only', async () => {
  const observation = getFrameworkObservation()
  if (!observation) throw new Error('Actual installed observation missing')
  if (Reflect.get(globalThis, '__reportingRefusalMode') === 'malformed') {
    await observation.taskUpdate(() => []).catch(() => {})
    expect(observation.signal.aborted).toBe(true)
    trace.push({
      kind: 'malformed-ack-reporting-failure',
      payload: window.__waffleFramework?.snapshot(),
    })
    return
  }
  if (Reflect.get(globalThis, '__reportingRefusalMode') === 'capacity') {
    await capacityBurst()
    expect(observation.signal.aborted).toBe(true)
    return
  }
  const result = await observation
    .error(() => {
      throw new Error('synthetic reporting refusal')
    })
    .then(
      () => 'fulfilled',
      () => 'rejected',
    )
  expect(result).toBe('rejected')
  expect(observation.signal.aborted).toBe(true)
}, 15000)

test('official update and both error paths survive reporting refusal', async () => {
  const endpoint = testerEndpoint()
  observeOriginalErrors()
  const originalRpcCount = trace.filter((item) => item.kind === 'rpc').length
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    trace.push({ kind: 'console.error', payload: args })
  }
  try {
    const result: unknown = Reflect.apply(endpoint.unhandledError, undefined, [
      rawError('tester'),
      'Synthetic tester error',
    ])
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(
      trace.filter((item) => item.kind.startsWith('read:tester:')).map((item) => item.kind),
    ).toEqual(['read:tester:name', 'read:tester:message', 'read:tester:stack'])
    const before = trace.filter((item) => item.kind === 'rpc').length
    expect(window.dispatchEvent(new ErrorEvent('error', { error: rawError('browser') }))).toBe(true)
    expect(trace.filter((item) => item.kind === 'rpc')).toHaveLength(before)
    await until(() => trace.some((item) => item.kind === 'console.error'))
    expect(
      trace.filter((item) => item.kind.startsWith('read:browser:')).map((item) => item.kind),
    ).toEqual(['read:browser:name', 'read:browser:message', 'read:browser:stack'])
    expect(trace.filter((item) => item.kind === 'rpc')).toHaveLength(originalRpcCount + 2)
    expect(trace.filter((item) => item.kind === 'rpc').every((item) => item.receiver)).toBe(true)
    expect(trace.find((item) => item.kind === 'console.error')?.payload).toEqual([0])
    const browser: unknown = Reflect.get(globalThis, '__vitest_browser_runner__')
    if (!object(browser) || !Array.isArray(browser.cleanups))
      throw new Error('Actual cleanup list missing')
    browser.cleanups.push(() => Promise.reject(rawError('cleanup')))
    trace.push({ kind: 'cleanup-registered' })
  } finally {
    console.error = originalConsoleError
    // Keep the owned RPC observer until the actual cleanup callback runs; the page is then destroyed.
  }
}, 15000)

async function suiteOutcomes(runner: Record<string, unknown>): Promise<void> {
  const prototype: unknown = Object.getPrototypeOf(Object.getPrototypeOf(runner))
  if (!object(prototype) || typeof runner.onBeforeRunSuite !== 'function')
    throw new Error('Actual original suite owner missing')
  const previous = Object.getOwnPropertyDescriptor(prototype, 'onBeforeRunSuite')
  const suite = { type: 'suite', id: 'synthetic-suite-owner' }
  try {
    for (const reason of [0, false, '', null, undefined]) {
      Object.defineProperty(prototype, 'onBeforeRunSuite', {
        configurable: true,
        value: () => Promise.reject(reason),
      })
      const actual: unknown = Reflect.apply(runner.onBeforeRunSuite, runner, [suite])
      const result = await Promise.resolve(actual).then(
        () => ({ kind: 'fulfilled' }),
        (caught: unknown) => ({ kind: 'rejected', reason: caught }),
      )
      expect(result).toEqual({ kind: 'rejected', reason })
    }
    let reads = 0
    // oxlint-disable-next-line unicorn/no-thenable -- Deliberate original thenable fixture.
    const thenable = Object.defineProperty({}, 'then', { get: readThen })
    Object.defineProperty(prototype, 'onBeforeRunSuite', {
      configurable: true,
      value: () => thenable,
    })
    function readThen() {
      reads++
      return (resolve: () => void) => resolve()
    }

    await Reflect.apply(runner.onBeforeRunSuite, runner, [suite])
    expect(reads).toBe(1)
    trace.push({ kind: 'suite-falsy-outcomes-and-single-then-read' })
  } finally {
    if (previous) Object.defineProperty(prototype, 'onBeforeRunSuite', previous)
    else Reflect.deleteProperty(prototype, 'onBeforeRunSuite')
  }
}

test('official update returns its original result after refusal', async () => {
  const browser: unknown = Reflect.get(globalThis, '__vitest_browser_runner__')
  const worker: unknown = Reflect.get(globalThis, '__vitest_worker__')
  if (!object(browser) || !object(browser.runner) || !object(worker) || !object(worker.rpc))
    throw new Error('Missing installed original runner')
  const method = browser.runner.onTaskUpdate
  if (typeof method !== 'function') throw new Error('Missing installed original update')
  await suiteOutcomes(browser.runner)
  const original = worker.rpc
  // oxlint-disable-next-line unicorn/no-thenable -- Detect any observation of the original return.
  const result = Object.defineProperty({}, 'then', {
    get() {
      throw new Error('Original update result was observed')
    },
  })
  worker.rpc = new Proxy(original, {
    get(target, key, receiver) {
      if (key !== 'onTaskUpdate') return Reflect.get(target, key, receiver)
      return () => {
        trace.push({ kind: 'update-after-refusal' })
        return result
      }
    },
  })
  try {
    expect(Reflect.apply(method, browser.runner, [[], []])).toBe(result)
  } finally {
    worker.rpc = original
  }
}, 15000)
