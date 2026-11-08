import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test, vi } from 'vitest'
import { nativeUsage, parseNativeArguments } from './ios-browser-options.ts'
import { verifyNativeSource } from './ios-browser-source.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const stage = 'selector'
const selected = nativeStage(stage)

test('Selector selects the complete original with all platform and parameter rows', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/selector.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/render/tests/selector.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.equal(selected.expected.length, 49)
  assert.equal(new Set(selected.expected.map((row) => row.fullName)).size, 49)
  assert.equal(new Set(selected.expected.map((row) => row.sourceKey)).size, 49)
  assert(
    selected.expected.every(
      (row) => row.file === selected.file && row.timeoutMs === 15000 && row.retries === 0,
    ),
  )
  assert.deepEqual(
    selected.expected.slice(0, 10).map((row) => row.fullName),
    [
      'Linux client hints',
      'Linux legacy platform',
      'macOS',
      'Windows',
      'Android client hints',
      'Android legacy platform',
      'ChromeOS client hints',
      'ChromeOS legacy platform',
      'client hints precedence',
      'unknown platform',
    ].map((name) => `compatible renderer selection > selects the automatic renderer for ${name}`),
  )
  assert.deepEqual(
    selected.expected.slice(23, 25).map((row) => row.fullName),
    ['abort', 'dispose'].map(
      (action) =>
        `compatible renderer selection > disposes WebGPU recovery that finishes after ${action} and preserves settings while acquiring it`,
    ),
  )
  assert.deepEqual(
    selected.expected.slice(30, 34).map((row) => row.sourceKey),
    [
      'src/render/tests/selector.browser.test.ts:424:0',
      'src/render/tests/selector.browser.test.ts:424:1',
      'src/render/tests/selector.browser.test.ts:424:2',
      'src/render/tests/selector.browser.test.ts:424:3',
    ],
  )
  assert.notEqual(selected.file, nativeStage('managed-fallback').file)
})

test('Selector complete-byte identity rejects any original change', async () => {
  const source = await readFile(selected.file)
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.concat([source, Buffer.from('\n')]))
  await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  await verifyNativeSource(stage)
})

test('Selector result validation rejects missing rows, duplicate IDs and changed outcomes', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (let index = 0; index < result.cases.length; index += 1)
    assert.throws(() =>
      verifyNativeStage(
        stage,
        {
          ...result,
          cases: result.cases.filter((_row, at) => at !== index),
        },
        receiptFixture,
      ),
    )
  const altered = [
    result.cases.concat(result.cases.slice(0, 1)),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 20000 } })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })),
    result.cases.map((row) => ({ ...row, actualId: 'repeated' })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'fail' } })),
  ]
  for (const cases of altered)
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('managed-fallback'), receiptFixture))
})

test('Selector appears in launcher and verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
