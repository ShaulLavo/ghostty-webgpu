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

const stage = 'font-geometry'
const selected = nativeStage(stage)
const databaseOperation: 'allocateDatabase' extends keyof FrameworkHost ? true : false = false

function digest(source: string | Uint8Array): string {
  return createHash('sha256').update(source).digest('hex')
}

test('font geometry selects every unchanged original with its exact source location and clock', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/font-geometry.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected the explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  assert.equal(selected.expected.length, 3)
  const registrations = source
    .split('\n')
    .flatMap((line, index) =>
      line.startsWith('it(') ? [`src/dom/tests/font-geometry.browser.test.ts:${index + 1}:0`] : [],
    )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    registrations,
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.equal(source.match(/^beforeAll\(/gm)?.length, 1)
  assert.equal(source.match(/^afterAll\(/gm)?.length, 1)
  assert.equal(source.match(/onTestFinished\(\(\) =>/g)?.length, 4)
  assert.equal(source.match(/expect\.poll\(/g)?.length, 2)
  assert.equal(databaseOperation, false)
  const helper = await readFile(new URL('../src/tests/fonts.ts', import.meta.url))
  assert.equal(digest(helper), 'bcd5349102191d841907c49920bb810b3f00d7b8dc604717be2968291ecb1f1c')
  const mutations = [
    source.replace('[1, 1.25, 2]', '[1, 2]'),
    source.replace('[0.5, 0.6, 1, 1.2]', '[1, 1.2]'),
    source.replace('[1.2, 1]', '[1]'),
    source.replace('getPixelRatio: () => 2', 'getPixelRatio: () => 1'),
    source.replace('getImageData(0, fitted.deviceCellHeight - 1', 'getImageData(0, 0'),
    source.replace('await face.load()', 'face'),
    source.replace('document.fonts.delete(face)', 'undefined'),
    source.replace('onTestFinished(() => terminal.dispose())', 'onTestFinished(() => {})'),
    source.replace("from 'ghostty-web'", "from '../replacement.js'"),
    source.replace("it('fits", "it.skip('fits"),
    source.replace('expect.poll(() => terminal.hasPendingFrame)', 'expect.poll(() => false)'),
    source + "\nit('extra case', () => {})\n",
  ]
  for (const changed of mutations) {
    assert.notEqual(changed, source)
    assert.notEqual(digest(changed), nativeSourceHashes[stage])
  }
})

test('font geometry requires all three original passes and rejects altered identities and partial results', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (const changes of [
    { exit: 0 },
    { rootBrowserSuiteComplete: true },
    { cases: [] },
    { cases: result.cases.slice(1) },
    { cases: result.cases.concat(result.cases.slice(0, 1)) },
    { cases: result.cases.map((row) => ({ ...row, started: false })) },
    {
      cases: result.cases.map((row) => ({
        ...row,
        expected: { ...row.expected, sourceKey: 'other' },
      })),
    },
    {
      cases: result.cases.map((row) => ({
        ...row,
        expected: { ...row.expected, fullName: 'other' },
      })),
    },
    { cases: result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 1 } })) },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })) },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'fail' } })) },
  ])
    assert.throws(() => verifyNativeStage(stage, { ...result, ...changes }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('font-fixture'), receiptFixture))
  assert.throws(() => verifyNativeStage(stage, result, { ...receiptFixture, exit: 0 }))
})

test('font geometry preserves safe equal ACKs, zero pending, and finite fractional cutoffs', () => {
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
        { ...result, documents: documents.map((row) => ({ ...row, ...changes })) },
        receiptFixture,
      ),
    )
})
