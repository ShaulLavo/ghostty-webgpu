import { expect } from 'vitest'
import type {} from '../node_modules/waffle/tests/page-runner/framework-bootstrap.ts'
import type { FrameworkObservation } from 'waffle/testing/page-runner/framework-page'

type Snapshot = {
  pending: number
  ackedThrough: number
  failure: string | null
  contentClosed: boolean
}
type Transport = (url: string, init: RequestInit) => Promise<Response>
type Realm = {
  observation: FrameworkObservation
  window: Window
  snapshot: () => Snapshot
}

function observation(value: unknown): value is FrameworkObservation {
  if (value === null || typeof value !== 'object') return false
  const methods = [
    'collected',
    'taskStarted',
    'taskUpdate',
    'caseSettled',
    'error',
    'executionFlushed',
    'testerCleanupSettled',
    'cleanupResponseReceived',
    'catcherInstalled',
    'waitForInitialViewport',
    'waitForRetirement',
  ]
  return (
    methods.every((name) => typeof Reflect.get(value, name) === 'function') && 'signal' in value
  )
}

export async function inReportingRealm(
  use: (realm: Realm) => Promise<void>,
  post?: Transport,
  release: () => void = () => {},
): Promise<void> {
  const frame = document.createElement('iframe')
  const waiting = Promise.withResolvers<void>()
  const requests = new Set<Promise<unknown>>()
  const bodyTransport: Transport =
    post ??
    (async (_url, init) => {
      const body: unknown = JSON.parse(String(init.body))
      if (body === null || typeof body !== 'object' || !('seq' in body))
        throw new Error('Missing sequence')
      return Response.json({ ackedThrough: body.seq })
    })
  frame.src = '/__ghostty_reporting_realm.html'
  document.body.append(frame)
  try {
    await new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve()
      frame.onerror = reject
    })
    const child = frame.contentWindow
    if (!child) throw new Error('Missing isolated reporting realm')
    Reflect.set(child, '__reportingReady', waiting.resolve)
    Reflect.set(child, 'fetch', (url: string, init: RequestInit) => {
      if (url.startsWith('/retire'))
        return Promise.resolve(Response.json({ kind: 'live', retire: false }))
      const request =
        url === '/heartbeat'
          ? Promise.resolve(Response.json({ kind: 'live', retire: false }))
          : bodyTransport(url, init)
      requests.add(request)
      void request.then(
        () => requests.delete(request),
        () => requests.delete(request),
      )
      return request
    })
    const script = child.document.createElement('script')
    script.src = '/__ghostty_reporting_bootstrap.js'
    Reflect.set(child, '__waffleFrameworkConfiguration', {
      run: 'isolated-synthetic',
      token: 'isolated-token',
      kind: 'tester',
      url: child.location.href,
    })
    script.onload = () => waiting.resolve()
    script.onerror = waiting.reject
    child.document.head.append(script)
    await waiting.promise
    const accessor: unknown = Reflect.get(child, Symbol.for('waffle.framework.observation'))
    const actual: unknown = typeof accessor === 'function' ? accessor() : undefined
    if (!observation(actual)) throw new Error('Actual installed observation missing')
    const bridge = child.__waffleFramework
    if (!bridge) throw new Error('Actual installed bootstrap missing')
    await until(() => bridge.snapshot().pending === 0)
    await use({ observation: actual, window: child, snapshot: bridge.snapshot })
  } finally {
    release()
    const child = frame.contentWindow
    child?.dispatchEvent(new Event('pagehide'))
    await Promise.allSettled(Array.from(requests))
    frame.remove()
  }
}

export async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Synthetic reporting boundary not reached')
}

export function payload(init: RequestInit): Record<string, unknown> {
  const value: unknown = JSON.parse(String(init.body))
  if (value === null || typeof value !== 'object') throw new Error('Missing encoded report')
  return Object.fromEntries(Object.entries(value))
}
export async function rejected(
  promise: Promise<unknown>,
): Promise<{ kind: 'rejected'; reason: unknown }> {
  const outcome = await promise.then(
    () => ({ kind: 'fulfilled' as const }),
    (reason: unknown) => ({ kind: 'rejected' as const, reason }),
  )
  expect(outcome.kind).toBe('rejected')
  if (outcome.kind !== 'rejected') throw new Error('Expected rejected synthetic operation')
  return outcome
}
