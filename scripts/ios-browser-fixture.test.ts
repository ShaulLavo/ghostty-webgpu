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

const stage = 'font-fixture'
const selected = nativeStage(stage)
const file = 'src/tests/fonts.browser.test.ts'
const databaseOperation: 'allocateDatabase' extends keyof FrameworkHost ? true : false = false

test('the complete font fixture keeps its original fetch, bytes, and FontFace assertions', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/font-fixture.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected the explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  assert.equal(selected.expected.length, 1)
  assert.equal(selected.expected[0]?.sourceKey, `${file}:4:0`)
  assert.match(source.split('\n')[3] ?? '', /^it\(/)
  assert.equal(source.match(/^it\(/gm)?.length, 1)
  assert.equal(source.match(/\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/g), null)
  assert(source.includes('await fetch(testFontUrl)'))
  assert(source.includes('expect(response.status).toBe(200)'))
  assert(source.includes("expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('wOF2')"))
  assert(source.includes("const face = new FontFace('BrowserFixtureFont', bytes)"))
  assert(source.includes('await expect(face.load()).resolves.toBe(face)'))
  const helper = await readFile(new URL('../src/tests/fonts.ts', import.meta.url))
  assert.equal(
    createHash('sha256').update(helper).digest('hex'),
    'bcd5349102191d841907c49920bb810b3f00d7b8dc604717be2968291ecb1f1c',
  )
  assert.equal(databaseOperation, false)
  for (const changed of [
    source.replace('fetch(testFontUrl)', "fetch('replacement.woff2')"),
    source.replace('toBe(200)', 'toBe(404)'),
    source.replace("toBe('wOF2')", "toBe('other')"),
    source.replace('resolves.toBe(face)', 'resolves.toBeDefined()'),
    source.replace("it('serves", "it.skip('serves"),
    source + '\nafterEach(() => {})\n',
    source + "\nit('extra case', () => {})\n",
  ]) {
    assert.notEqual(changed, source)
    assert.notEqual(createHash('sha256').update(changed).digest('hex'), nativeSourceHashes[stage])
  }
})

test('font fixture evidence requires the entire original and sound partial completion', () => {
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

test('font fixture evidence keeps zero pending, safe ACKs, and fractional cutoffs', () => {
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
