import { expect, test } from 'vitest'

test('real throttling and final flush retain separate RPC and ACK owners', async () => {
  const worker: unknown = Reflect.get(globalThis, '__vitest_worker__')
  if (
    !worker ||
    typeof worker !== 'object' ||
    !('rpc' in worker) ||
    !worker.rpc ||
    typeof worker.rpc !== 'object'
  )
    throw new Error('Actual installed worker missing')
  const original = worker.rpc
  const release = Promise.withResolvers<void>()
  const trace = { rpcHeld: false, bodyFinished: false, rpcReleased: false, calls: 0 }
  Reflect.set(globalThis, '__reportingFlush', trace)
  Reflect.set(globalThis, '__reportingReleaseRpc', () => {
    trace.rpcReleased = true
    release.resolve()
  })
  worker.rpc = new Proxy(original, {
    get(target, key, receiver) {
      const method: unknown = Reflect.get(target, key, receiver)
      if (key !== 'onTaskUpdate' || typeof method !== 'function') return method
      return (...args: unknown[]) => {
        trace.calls++
        const actual: unknown = Reflect.apply(method, target, args)
        trace.rpcHeld = true
        return release.promise.then(() => actual)
      }
    },
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(trace.rpcHeld).toBe(true)
    expect(trace.rpcReleased).toBe(false)
    trace.bodyFinished = true
  } finally {
    worker.rpc = original
  }
}, 15000)
