import assert from 'node:assert/strict'
import { test } from 'vitest'
import { checkedCommand } from './ios-browser.ts'

const hostile = {
  get message(): never {
    throw new Error('Must not inspect an official rejection')
  },
  toString(): never {
    throw new Error('Must not coerce an official rejection')
  },
}

test.each([
  { label: 'undefined', reason: undefined },
  { label: 'null', reason: null },
  { label: 'false', reason: false },
  { label: 'zero', reason: 0 },
  { label: 'empty', reason: '' },
  { label: 'hostile', reason: hostile },
])('keeps exact rejection identity $label', async ({ reason }) => {
  let checks = 0
  const secondary: unknown[] = []
  const postFailure = new Error('Changed after settlement')
  const check = () => {
    checks++
    if (checks === 2) throw postFailure
  }
  const operation = checkedCommand(check, () => Promise.reject(reason), secondary)
  await operation.then(
    () => assert.fail('Official rejection fulfilled'),
    (actual) => assert.equal(actual, reason),
  )
  assert.deepEqual(secondary, [postFailure])
})

test('checks synchronously before dispatch and never invokes a denied callback', async () => {
  const failure = new Error('Queued context changed')
  let calls = 0
  const operation = checkedCommand(
    () => {
      throw failure
    },
    async () => {
      calls++
      return 42
    },
    [],
  )
  await assert.rejects(operation, (actual) => actual === failure)
  assert.equal(calls, 0)
})

test('checks both settlements and preserves exact result and Buffer references', async () => {
  const buffer = Buffer.from('SYNTHETIC TRANSPORT bytes, not pixels')
  const result = { buffer, path: '/consumer-owned/path.png' }
  const deferred = Promise.withResolvers<typeof result>()
  let checks = 0
  const operation = checkedCommand(
    () => {
      checks++
    },
    () => deferred.promise,
    [],
  )
  assert.equal(checks, 1)
  deferred.resolve(result)
  const actual = await operation
  assert.equal(checks, 2)
  assert.equal(actual, result)
  assert.equal(actual.buffer, buffer)
})

test('a fulfilled official callback cannot survive a failed context post-check', async () => {
  const failure = new Error('Project changed')
  let checks = 0
  const operation = checkedCommand(
    () => {
      if (++checks === 2) throw failure
    },
    async () => 42,
    [],
  )
  await assert.rejects(operation, (actual) => actual === failure)
})
