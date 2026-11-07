import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { parseNativeArguments } from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { nativeSourceHashes } from './ios-browser-source.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'

const original = new URL('../src/dom/tests/font-resources.browser.test.ts', import.meta.url)
const resource = new URL(
  '../src/dom/tests/fixtures/font-resource/replacement.woff2',
  import.meta.url,
)

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('the complete font file has an explicit stage and unchanged real font input', async () => {
  const request = parseNativeArguments([
    '--stage',
    'font-resources',
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/font-resources.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected the explicit run request')
  assert.equal(request.options.stage, 'font-resources')
  const source = await readFile(original)
  assert.equal(sha256(source), nativeSourceHashes['font-resources'])
  const font = await readFile(resource)
  assert.equal(font.byteLength, 412)
  assert.equal(font.subarray(0, 4).toString('ascii'), 'wOF2')
  assert.equal(sha256(font), '2dd0680725446a94aa181d59cfa4736ae3ef059dbec443982346429001a65614')
  assert(
    source
      .toString()
      .includes("new URL('./fixtures/font-resource/replacement.woff2', import.meta.url)"),
  )
  assert(source.toString().includes('data:font/woff2;base64,AAECAw=='))
})

test('font case source identities retain every original registration and parameter ordinal', async () => {
  const source = await readFile(original, 'utf8')
  const lines = source.split('\n')
  const expected = nativeStage('font-resources').expected
  const keys = expected.map((row) => row.sourceKey)
  assert.equal(new Set(keys).size, 5)
  for (const [index, line] of [12, 12, 47, 75, 102].entries()) {
    const ordinal = index === 1 ? 1 : 0
    assert.equal(keys[index], `src/dom/tests/font-resources.browser.test.ts:${line}:${ordinal}`)
    assert.match(lines[line - 1] ?? '', /^it(?:\(|\.each\()/)
  }
  assert.equal(source.match(/^it\(/gm)?.length, 3)
  assert.equal(source.match(/^it\.each\(/gm)?.length, 1)
  assert.equal(source.match(/\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/g), null)
})

test('font results remain partial and reject substituted parameters or missing starts', () => {
  const result = resultFixture('font-resources')
  verifyNativeStage('font-resources', result, receiptFixture)
  assert.throws(() => verifyNativeStage('font-resources', { ...result, exit: 0 }, receiptFixture))
  assert.throws(() =>
    verifyNativeStage('font-resources', resultFixture('viewport'), receiptFixture),
  )
  const first = result.cases[0]
  assert.ok(first)
  const cases = result.cases.map((row, index) => ({
    ...row,
    expected: index === 1 ? first.expected : row.expected,
  }))
  assert.throws(() => verifyNativeStage('font-resources', { ...result, cases }, receiptFixture))
  assert.throws(() =>
    verifyNativeStage(
      'font-resources',
      { ...result, cases: result.cases.slice(1) },
      receiptFixture,
    ),
  )
})
