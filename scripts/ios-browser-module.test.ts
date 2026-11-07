import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import type { FrameworkHost } from 'waffle/testing/page-runner/framework'
import { parseNativeArguments } from './ios-browser-options.ts'
import { nativeSourceHashes, verifyNativeSource } from './ios-browser-source.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'

const stage = 'module-mock'
const selected = nativeStage(stage)
const file = 'src/dom/tests/module-mock.browser.test.ts'
const databaseOperation: 'allocateDatabase' extends keyof FrameworkHost ? true : false = false

test('the complete module-mock stage keeps the original registration and mock factory', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/module-mock.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected the explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  assert.equal(selected.expected.length, 1)
  assert.equal(selected.expected[0]?.sourceKey, `${file}:6:0`)
  assert.match(source.split('\n')[5] ?? '', /^it\(/)
  assert.equal(source.match(/^it\(/gm)?.length, 1)
  assert.equal(source.match(/\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/g), null)
  assert(
    source.includes(
      `vi.mock('@discoveryjs/json-ext', () => ({ stringifyChunked: () => ['"intercepted"'] }))`,
    ),
  )
  assert(
    source.includes(
      `await vi.importActual<typeof import('@discoveryjs/json-ext')>('@discoveryjs/json-ext')`,
    ),
  )
  assert(
    source.includes(
      `expect([...actual.stringifyChunked({ normal: true })]).toEqual(['{"normal":true}'])`,
    ),
  )
  assert.equal(databaseOperation, false)
  for (const changed of [
    source.replace('[\'"intercepted"\']', '[\'"substituted"\']'),
    source.replace('vi.importActual', 'vi.importMock'),
    source.replace('normal: true', 'normal: false'),
    source.replace("it('intercepts", "it.skip('intercepts"),
    source + '\nafterEach(() => {})\n',
    source + "\nit('extra case', () => {})\n",
  ]) {
    assert.notEqual(changed, source)
    assert.notEqual(createHash('sha256').update(changed).digest('hex'), nativeSourceHashes[stage])
  }
})

test('module-mock evidence requires the entire original and sound partial completion', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (const changes of [
    { exit: 0 },
    { rootBrowserSuiteComplete: true },
    { cases: [] },
    { cases: result.cases.concat(result.cases) },
    { cases: result.cases.map((row) => ({ ...row, started: false })) },
    {
      cases: result.cases.map((row) => ({
        ...row,
        expected: { ...row.expected, sourceKey: 'substituted' },
      })),
    },
    {
      cases: result.cases.map((row) => ({
        ...row,
        expected: { ...row.expected, fullName: 'renamed' },
      })),
    },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })) },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'fail' } })) },
  ])
    assert.throws(() => verifyNativeStage(stage, { ...result, ...changes }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('history'), receiptFixture))
})

test('module-mock evidence keeps zero pending, safe ACKs, and fractional cutoffs', () => {
  const result = resultFixture(stage)
  const documents = result.documents.map((row) => ({
    ...row,
    acceptedThrough: 0,
    ackedThrough: 0,
    cutoff: 0.25,
  }))
  verifyNativeStage(stage, { ...result, documents }, receiptFixture)
  for (const changes of [
    { acceptedThrough: 1 },
    { pending: 1 },
    { acceptedThrough: -1, ackedThrough: -1 },
    { acceptedThrough: 0.5, ackedThrough: 0.5 },
    { acceptedThrough: Number.MAX_SAFE_INTEGER + 1, ackedThrough: Number.MAX_SAFE_INTEGER + 1 },
    { cutoff: -1 },
    { cutoff: Infinity },
    { cutoff: NaN },
  ])
    assert.throws(() =>
      verifyNativeStage(
        stage,
        {
          ...result,
          documents: documents.map((row) => ({ ...row, ...changes })),
        },
        receiptFixture,
      ),
    )
  assert.throws(() => verifyNativeStage(stage, result, { ...receiptFixture, exit: 0 }))
})
