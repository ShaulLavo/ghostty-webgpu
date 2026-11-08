import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, vi } from 'vitest'
import { parseNativeArguments } from './ios-browser-options.ts'
import { nativeSourceHashes, verifyNativeSource } from './ios-browser-source.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const stage = 'pixel-damage'
const selected = nativeStage(stage)
const file = 'src/render/pixels/damage.browser.test.ts'

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

test('pixel damage selects every DPR row and the inherited-filter case with original clocks', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/pixel-damage.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  assert(source.includes('it.each([1, 1.25, 1.5, 2])('))
  const title = source.split('\n')[19]?.trim().slice(1, -2)
  assert.equal(title, 'uploads only warm edited pixel columns at DPR %s with exact RGBA')
  const registrations = [1, 1.25, 1.5, 2]
    .map((dpr, index) => ({
      fullName: title.replace('%s', String(dpr)),
      sourceKey: `${file}:19:${index}`,
    }))
    .concat([
      {
        fullName: source.split('\n')[149]?.split("'")[1] ?? '',
        sourceKey: `${file}:150:0`,
      },
    ])
  assert.deepEqual(
    selected.expected.map(({ fullName, sourceKey }) => ({ fullName, sourceKey })),
    registrations,
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.equal(source.match(/\bexpect\(/g)?.length, 19)
  assert.equal(source.match(/\bafterEach\(/g)?.length, 1)
  assert.equal(source.match(/new TestClock\(/g)?.length, 3)
  assert(source.includes('for (const cleanup of cleanups.splice(0).reverse()) cleanup()'))
  assert.equal(source.match(/expect\.poll\(/g), null)
  assert.equal(source.match(/\b(?:setTimeout|setInterval|requestAnimationFrame)\(/g), null)
})

test('pixel damage source gate rejects changed DPR rows, pixel oracles, loops, clocks and filter behavior', async () => {
  const source = await readFile(selected.file, 'utf8')
  for (const [before, after] of [
    ['[1, 1.25, 1.5, 2]', '[1, 1.5, 2]'],
    ['[1, 1.25, 1.5, 2]', '[1, 1.25, 1.25, 2]'],
    ['[1, 1.25, 1.5, 2]', '[1, 1.25, 1.5, 3]'],
    ['expected[index]', 'actual[index]'],
    ['new TestClock()', 'browserClock()'],
    ['clock.flushFrame()', 'clock.frames.clear()'],
    ["['\\x1b[1;8HX', '\\x1b[1;9HY']", "['\\x1b[1;8HX']"],
    ['reference.clearTextureAtlas()', 'reference.notifyWrite()'],
    ['toHaveBeenCalledTimes(1)', 'toHaveBeenCalled()'],
    ['toBeLessThan(canvas.width / 2)', 'toBeLessThan(canvas.width)'],
    ["toThrow('Injected output transport failure')", 'toBeDefined()'],
    ['copy.mockImplementationOnce', 'copy.mockImplementation'],
    ['.splice(0).reverse()', '.splice(0)'],
    ['vi.restoreAllMocks()', 'vi.clearAllMocks()'],
    ["output.filter = 'opacity(50%)'", "output.filter = 'none'"],
    ['toBe(filter)', "toBe('none')"],
    [
      'metrics.selfCopies - before.selfCopies).toBe(1)',
      'metrics.selfCopies - before.selfCopies).toBe(0)',
    ],
    ["it('preserves pixel-scroll", "it.skip('preserves pixel-scroll"],
    ['it.each(', 'it.skip.each('],
  ]) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    assert.notEqual(digest(changed), nativeSourceHashes[stage])
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(source + "\nit('extra', () => {})\n"))
  await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  await verifyNativeSource(stage)
})

test('pixel damage rejects incomplete, substituted, failed or retried outcomes', () => {
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
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'skip' } })) },
  ])
    assert.throws(() => verifyNativeStage(stage, { ...result, ...changes }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('stamp-cache'), receiptFixture))
  assert.throws(() => verifyNativeStage(stage, result, { ...receiptFixture, exit: 0 }))
})

test('pixel damage keeps exact retirement ACKs and finite fractional cutoffs', () => {
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
