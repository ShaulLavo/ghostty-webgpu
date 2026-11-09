import assert from 'node:assert/strict'
import { test } from 'vitest'
import { errorJson, frameworkUpdates } from './ios-browser-records.ts'
import { frameworkEndReporter } from './ios-browser-report.ts'
import { viewportCases } from './ios-browser-cases.ts'
import { createBrowserTestConfig } from '../vitest.browser.config.ts'
import { createFrameworkControl } from 'waffle/testing/page-runner/framework'
import { getFrameworkObservation } from 'waffle/testing/page-runner/framework-page'

import { getGlobalDispatcher } from 'undici'
import { OwnedFrameworkDispatcher, runFrameworkNode } from './ios-browser-node.ts'

test('installed public imports and original desktop factory', () => {
  assert.equal(typeof createFrameworkControl, 'function')
  assert.equal(getFrameworkObservation(), undefined)
  const config = createBrowserTestConfig()
  assert.equal(config.test.browser.provider.name, 'playwright')
  assert.deepEqual(Object.keys(config.test.browser.commands), ['insertText'])
  assert.equal(config.test.fileParallelism, false)
  assert.equal(viewportCases.length, 5)
  assert(viewportCases.every((row) => row.timeoutMs === 15000 && row.retries === 0))
})
test('real declared update packs preserve errors, hooks, retries and duplicate revisions', () => {
  const result = {
    state: 'fail',
    errors: [{ name: 'Error', message: 'fixture failure' }],
    hooks: { afterEach: 'fail' },
    retryCount: 0,
  } satisfies import('vitest').RunnerTaskResult
  const pack = ['actual-id', result, {}] satisfies import('vitest').RunnerTaskResultPack
  const actual = frameworkUpdates([pack, pack, ['pending', undefined, {}]])
  assert.equal(actual.length, 2)
  assert.deepEqual(actual[0], {
    id: 'actual-id',
    state: 'fail',
    errors: result.errors,
    hooks: result.hooks,
    retryCount: 0,
  })
  assert.throws(
    () => frameworkUpdates([['queued', { state: 'queued' }, {}]]),
    /Unsupported installed/,
  )
})
test('errors do not truncate assertion arrays and serialization fails closed', () => {
  const bytes = Array.from({ length: 4096 }, (_, index) => index % 256)
  assert.deepEqual(errorJson({ actual: bytes, expected: bytes, message: 'pixel mismatch' }), {
    actual: bytes,
    expected: bytes,
    message: 'pixel mismatch',
  })
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  assert.throws(() => errorJson(cycle), /Circular/)
  assert.throws(() => errorJson({ callback() {} }), /Non-JSON/)
})
test('ordinary result requires the real end event and preserves unhandled errors', async () => {
  const ordinary = frameworkEndReporter()
  assert.throws(ordinary.endStatus, /No ordinary Vitest/)
  await ordinary.reporter.onTestRunEnd?.(
    [],
    [{ name: 'Error', message: 'unhandled prepare error' }],
    'passed',
  )
  assert.deepEqual(ordinary.endStatus(), {
    status: 'failed',
    errors: [{ name: 'Error', message: 'unhandled prepare error' }],
  })
})

test('dedicated transport closes after execution and restores on success and failure', async () => {
  const previous = getGlobalDispatcher()
  let owned: OwnedFrameworkDispatcher | undefined
  await runFrameworkNode(async () => {
    const current = getGlobalDispatcher()
    assert(current instanceof OwnedFrameworkDispatcher)
    owned = current
    assert.equal(current.closed, false)
  })
  assert.equal(owned?.closed, true)
  assert.equal(getGlobalDispatcher(), previous)
  await assert.rejects(
    runFrameworkNode(async () => {
      throw new Error('LOCAL_EXECUTION_FAILURE')
    }),
    /LOCAL_EXECUTION_FAILURE/,
  )
  assert.equal(getGlobalDispatcher(), previous)
})

function inheritedNameError(throwOnSecondRead: boolean) {
  const error = new Error('synthetic inherited name')
  void error.stack
  let reads = 0
  const prototype = Object.create(Error.prototype)
  function name(this: Error): string {
    reads += 1
    if (reads > 1 && throwOnSecondRead) throw false
    Object.defineProperty(this, 'name', { get: name, configurable: true })
    return reads === 1 ? 'first name' : 'second name'
  }
  Object.defineProperty(prototype, 'name', { get: name, configurable: true })
  Object.setPrototypeOf(error, prototype)
  return { error, reads: () => reads }
}

test.each([false, true])(
  'an inherited Error name is captured before its getter adds an own property: throws=%s',
  (throwOnSecondRead) => {
    const fixture = inheritedNameError(throwOnSecondRead)
    const snapshot = errorJson(fixture.error)
    assert.equal(fixture.reads(), 1)
    assert(snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot))
    assert('name' in snapshot)
    assert.equal(snapshot.name, 'first name')
  },
)
