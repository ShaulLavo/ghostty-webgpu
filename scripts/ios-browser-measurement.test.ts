import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { parseNativeArguments } from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { nativeSourceHashes } from './ios-browser-source.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'

const original = new URL('../src/dom/tests/measurement.browser.test.ts', import.meta.url)
const assets = [
  ['ghostty-vt.wasm', 'de411c7abb6af40aa9c077b79c373cf11952e7801133d0855cdf3723be5b1426'],
  ['bridge.wasm', '3629e4a60d5404a4ebab476e488fe8834074e838c85c9ab488ffca8501a7ede0'],
] as const

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('the complete measurement stage binds the unchanged file and real Wasm inputs', async () => {
  const request = parseNativeArguments([
    '--stage',
    'measurement',
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/measurement.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected the explicit run request')
  assert.equal(request.options.stage, 'measurement')
  assert.equal(sha256(await readFile(original)), nativeSourceHashes.measurement)
  for (const [path, digest] of assets) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url))
    assert.equal(bytes.subarray(0, 4).toString('hex'), '0061736d')
    assert.equal(sha256(bytes), digest)
  }
  assert.throws(() => parseNativeArguments(['--stage', 'measurement']))
  assert.throws(() =>
    parseNativeArguments([
      '--stage',
      'measurement-extra',
      '--udid',
      '00000000-0000-0000-0000-000000000000',
      '--result',
      '/not-executed/measurement.json',
    ]),
  )
})

test('measurement source keys preserve all parameter rows, hooks, and host dimensions', async () => {
  const source = await readFile(original, 'utf8')
  const lines = source.split('\n')
  const keys = nativeStage('measurement').expected.map((row) => row.sourceKey)
  const sites = [
    [26, 0],
    [45, 0],
    [45, 1],
    [61, 0],
  ] as const
  assert.equal(new Set(keys).size, 4)
  for (const [index, [line, ordinal]] of sites.entries()) {
    assert.equal(keys[index], `src/dom/tests/measurement.browser.test.ts:${line}:${ordinal}`)
    assert.match(lines[line - 1] ?? '', /^  it(?:\(|\.each\()/)
  }
  assert.equal(source.match(/^  it\(/gm)?.length, 2)
  assert.equal(source.match(/^  it\.each\(/gm)?.length, 1)
  assert.deepEqual(source.match(/\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/g), [
    'afterEach(',
  ])
  assert(source.includes("host.style.width = '320px'"))
  assert(source.includes("host.style.height = '120px'"))
  assert(source.includes('for (const terminal of terminals.splice(0)) terminal.dispose()'))
  assert(source.includes('for (const host of hosts.splice(0)) host.remove()'))
})

test('measurement results reject parameter substitution and incomplete selected-file proof', () => {
  const result = resultFixture('measurement')
  verifyNativeStage('measurement', result, receiptFixture)
  assert.throws(() => verifyNativeStage('measurement', resultFixture('viewport'), receiptFixture))
  const first = result.cases[1]
  assert.ok(first)
  const cases = result.cases.map((row, index) => ({
    ...row,
    expected: index === 2 ? first.expected : row.expected,
  }))
  assert.throws(() => verifyNativeStage('measurement', { ...result, cases }, receiptFixture))
  assert.throws(() =>
    verifyNativeStage('measurement', { ...result, cases: result.cases.slice(1) }, receiptFixture),
  )
})
