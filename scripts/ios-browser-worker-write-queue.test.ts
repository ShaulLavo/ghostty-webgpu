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

const stage = 'worker-write-queue'
const selected = nativeStage(stage)

test('worker write queue selects the complete dist-worker original and all four cases', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/worker-write-queue.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/worker/write-queue.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'transfers owned batched buffers and acknowledges native parsing',
      'keeps batched output ahead of later write and appearance controls',
      'cancels a queued worker write without cancelling its neighbors',
      'rejects queued worker writes before disposal finishes',
    ],
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    [32, 54, 71, 89].map((line) => `src/worker/write-queue.browser.test.ts:${line}:0`),
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('write-queue').file)
})

test('worker queue source identity preserves real worker, font, transfer, cancellation and disposal', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ["'../../dist/worker/index.js'", "'../worker/index.js'"],
    ["backend: 'webgl'", "backend: 'auto'"],
    ['source: { url: testFontUrl }', 'source: { bytes: new Uint8Array() }'],
    ['timeBudgetMs: 12', 'timeBudgetMs: 120'],
    ["vi.spyOn(MessagePort.prototype, 'postMessage')", "vi.spyOn(Worker.prototype, 'postMessage')"],
    ['transfer.length === 1', 'transfer.length === 0'],
    ['postMessage.mockRestore()', 'postMessage.mockClear()'],
    ['controller.abort()', 'void controller'],
    ["expect(text).not.toContain('cancelled')", "expect(text).toContain('cancelled')"],
    ['Array.from({ length: 8 }', 'Array.from({ length: 7 }'],
    ['await disposal', 'void disposal'],
    ['for (const terminal of active.splice(0)) await terminal.dispose()', 'active.length = 0'],
    ['for (const container of containers.splice(0)) container.remove()', 'containers.length = 0'],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('worker queue saved-result validation rejects missing cases, duplicates and changed options', () => {
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
  assert.throws(() => verifyNativeStage(stage, resultFixture('write-queue'), receiptFixture))
})

test('worker queue appears in launcher and saved-result verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
