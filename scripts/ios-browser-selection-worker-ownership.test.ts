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

const stage = 'selection-worker-ownership'
const selected = nativeStage(stage)

test('worker selection ownership selects all three complete interruption rows', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/selection-worker-ownership.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(
      new URL('../src/dom/tests/selection-worker-ownership.browser.test.ts', import.meta.url),
    ),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    ['cancel', 'dispose', 'new press'].map(
      (interruption) =>
        `keeps real packaged native ownership when ${interruption} interrupts a stale pending release`,
    ),
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    [0, 1, 2].map(
      (index) => `src/dom/tests/selection-worker-ownership.browser.test.ts:12:${index}`,
    ),
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('worker-write-queue').file)
})

test('worker selection source identity preserves native authority, clocks and cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ["['cancel', 'dispose', 'new press']", "['cancel', 'dispose']"],
    ["backend: 'webgl'", "backend: 'auto'"],
    ['url: testFontUrl', "url: 'substitute.woff2'"],
    ["await execution.request('refresh', [0, 1])", 'await Promise.resolve()'],
    ['performance.now() + 5000', 'performance.now() + 10000'],
    ['setTimeout(resolve, 10)', 'setTimeout(resolve, 1)'],
    ["operation: 'selectionRelease'", "operation: 'selectionPress'"],
    ['expect(afterResize).toEqual(current)', 'expect(afterResize.layout).toEqual(current.layout)'],
    ['{ ...identity, generation: 0 }', '{ ...identity, generation: 1 }'],
    ["root.style.width = '440px'", "root.style.width = '400px'"],
    [
      'expect(changed.revision).toBeGreaterThan(identity.revision)',
      'expect(changed.revision).toBeGreaterThanOrEqual(identity.revision)',
    ],
    ['execution.dispose()', 'Promise.resolve()'],
    ['15000,', '20000,'],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('worker selection saved-result validation rejects missing rows and changed options', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  const missing: readonly unknown[] = Array.from(result.cases, (_row, index) =>
    result.cases.filter((_item, at) => at !== index),
  )
  const altered = [
    result.cases.concat(result.cases.slice(0, 1)),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 20000 } })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })),
  ]
  for (const cases of missing.concat(altered))
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('worker-write-queue'), receiptFixture))
})

test('worker selection ownership appears in launcher and verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
