import { expect, test } from 'vitest'
import type { FrameworkResult } from 'waffle/testing/page-runner/framework'
import { ReportingNodeOwner } from './ios-browser-reporting-owner.ts'

function raw(deadline = performance.now() + 100): FrameworkResult {
  return {
    suite: 'runner CPU control',
    run: 'not-native',
    trace: { status: 'not-requested' },
    cleanupDeadlineAt: deadline,
    expected: [],
    cases: [],
    collection: [],
    events: [],
    documents: [],
    binding: null,
    commandFailures: [],
    commandHooks: [],
    geometry: null,
    framework: { status: 'passed' },
    failures: [],
    fileComplete: true,
    rootBrowserSuiteComplete: false,
    omittedRootFiles: 'not enumerated',
    exit: 4,
    cleanup: {
      trace: { status: 'not-created', detail: 'CPU control' },
      session: { status: 'confirmed', detail: 'deleted' },
      launcher: { status: 'not-created', detail: 'CPU control' },
      callbacks: { status: 'confirmed', detail: 'joined' },
      provider: { status: 'confirmed', detail: 'joined' },
      context: { status: 'confirmed', detail: 'joined' },
      scratch: { status: 'confirmed', detail: 'removed' },
      serviceDisposition: 'CPU control',
    },
  }
}
function dispatcher(close: () => Promise<void>, restore = () => {}) {
  return { actual: { close }, identity: 'actual CPU dispatcher', restore }
}

test('memoized closer invokes actual close once and records each request', async () => {
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const owner = new ReportingNodeOwner(
    undefined,
    dispatcher(async () => {}),
  )
  owner.ownContext(
    {
      close: () => {
        calls++
        return gate.promise
      },
    },
    'actual context',
  )
  const first = owner.closeContext()
  expect(owner.closeContext()).toBe(first)
  expect(calls).toBe(1)
  gate.resolve()
  await first
  const result = await owner.finish(raw())
  expect(result.status).toBe('confirmed')
  expect(result.resources[1]?.closeInvocations).toBe(2)
})

test('dispatcher remains available through actual session deletion before host return', async () => {
  const order: string[] = []
  const owner = new ReportingNodeOwner(
    undefined,
    dispatcher(async () => {
      order.push('dispatcher closed')
    }),
  )
  const execution = owner.ownExecution(
    Promise.resolve().then(() => {
      order.push('session deleted')
    }),
    'execution',
  )
  expect(order).toEqual([])
  await execution
  order.push('host returned')
  const sdk = raw()
  await owner.finish(sdk)
  expect(order).toEqual(['session deleted', 'host returned', 'dispatcher closed'])
  expect(owner.finish(sdk)).toBe(owner.finish(sdk))
})

test('pending context and execution are not re-awaited and late settlement cannot rewrite sealed evidence', async () => {
  const context = Promise.withResolvers<void>()
  const execution = Promise.withResolvers<void>()
  const owner = new ReportingNodeOwner(
    undefined,
    dispatcher(async () => {}),
  )
  owner.ownContext({ close: () => context.promise }, 'held actual context')
  void owner.closeContext()
  owner.ownExecution(execution.promise, 'held actual execution')
  const sdk = raw()
  sdk.cleanup.context = { status: 'unconfirmed', detail: 'host deadline' }
  sdk.cleanup.callbacks = { status: 'unconfirmed', detail: 'host deadline' }
  const bytes = JSON.stringify(sdk)
  const result = await owner.finish(sdk)
  expect(result.status).toBe('unconfirmed')
  expect(result.exit).toBe(2)
  expect(result.sdkUnconfirmed).toEqual(['callbacks', 'context'])
  context.resolve()
  execution.resolve()
  await Promise.all([context.promise, execution.promise])
  await Promise.resolve()
  expect(result.resources.filter((item) => item.settlement === 'pending')).toHaveLength(2)
  expect(owner.observations().every((item) => item.settlement === 'fulfilled')).toBe(true)
  expect(JSON.stringify(sdk)).toBe(bytes)
})

test('only the remaining absolute allowance bounds dispatcher settlement and restores previous owner', async () => {
  const gate = Promise.withResolvers<void>()
  let restored = false
  const start = performance.now()
  const owner = new ReportingNodeOwner(
    undefined,
    dispatcher(
      () => gate.promise,
      () => {
        restored = true
      },
    ),
  )
  const result = await owner.finish(raw(start + 15))
  expect(performance.now() - start).toBeLessThan(500)
  expect(result.status).toBe('unconfirmed')
  expect(result.exit).toBe(2)
  expect(result.resources[0]?.settlement).toBe('pending')
  expect(restored).toBe(true)
  gate.resolve()
  await gate.promise
})

test('expired allowance never becomes a new cleanup window', async () => {
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const owner = new ReportingNodeOwner(
    () => 500,
    dispatcher(() => {
      calls++
      return gate.promise
    }),
  )
  const result = await owner.finish(raw(499))
  expect(calls).toBe(1)
  expect(result.status).toBe('unconfirmed')
  expect(result.observedAt).toBe(500)
  gate.resolve()
})

test('fixture rejection remains runner failure without changing ordinary SDK outcome', async () => {
  const owner = new ReportingNodeOwner(
    undefined,
    dispatcher(async () => {}),
  )
  await owner.ownFixture(Promise.reject(0), 'gate failure').catch(() => {})
  const sdk = raw()
  const result = await owner.finish(sdk)
  expect(result.exit).toBe(2)
  expect(sdk.exit).toBe(4)
  expect(sdk.framework?.status).toBe('passed')
  expect(sdk.fileComplete).toBe(true)
})
