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

const stage = 'mounted-scroll'
const selected = nativeStage(stage)
const file = 'src/render/canvas/mounted-scroll.browser.test.ts'

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

test('mounted scroll selects both renderer modes with original metrics, full RGBA and clocks', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/mounted-scroll.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  assert(source.includes("it.each(['canvas2d-fill-text', 'canvas2d-pixels'] as const)("))
  const title = source.split('\n')[53]?.trim().slice(1, -2)
  assert.equal(title, 'reuses rows after mounted public Terminal output scroll (%s)')
  const registrations = ['canvas2d-fill-text', 'canvas2d-pixels'].map((mode, index) => ({
    fullName: title.replace('%s', mode),
    sourceKey: `${file}:53:${index}`,
  }))
  assert.deepEqual(
    selected.expected.map(({ fullName, sourceKey }) => ({ fullName, sourceKey })),
    registrations,
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.equal(source.match(/\bexpect\(/g)?.length, 12)
  assert.equal(source.match(/new TestClock\(/g)?.length, 2)
  assert.equal(source.match(/clock.flushFrame\(/g)?.length, 3)
  assert.equal(source.match(/getImageData\(/g)?.length, 2)
  assert(source.includes('for (let row = 6; row < 10; row += 1)'))
  assert(source.includes('schedulerClock: clock'))
  assert(source.includes('new Promise(requestAnimationFrame)'))
  assert.equal(source.match(/expect\.poll\(/g), null)
})

test('mounted scroll source gate rejects changed modes, oracle, metrics, callbacks, clocks and cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ["['canvas2d-fill-text', 'canvas2d-pixels']", "['canvas2d-fill-text']"],
    ["['canvas2d-fill-text', 'canvas2d-pixels']", "['canvas2d-pixels', 'canvas2d-fill-text']"],
    ['expectedBytes[index]', 'actualBytes[index]'],
    ['actualBytes.length).toBe(expectedBytes.length)', 'actualBytes.length).toBe(0)'],
    ['new TestClock()', 'browserClock()'],
    ['clock.flushFrame()', 'clock.frames.clear()'],
    ['schedulerClock: clock', 'schedulerClock: undefined'],
    ['row < 10', 'row < 7'],
    ['toHaveBeenCalledOnce()', 'toHaveBeenCalled()'],
    [
      'metrics.repaintedRows - before.repaintedRows).toBe(1)',
      'metrics.repaintedRows - before.repaintedRows).toBe(6)',
    ],
    [
      'metrics.movedRows - before.movedRows).toBe(5)',
      'metrics.movedRows - before.movedRows).toBe(0)',
    ],
    ['reference?.dispose()', 'reference?.notifyWrite()'],
    ['terminal.dispose()', 'terminal.clear()'],
    ['runtime.dispose()', 'runtime.createTerminal()'],
    ['host.remove()', 'host.replaceChildren()'],
    ['vi.restoreAllMocks()', 'vi.clearAllMocks()'],
    ['new Promise(requestAnimationFrame)', 'Promise.resolve()'],
    ['it.each(', 'it.skip.each('],
  ]
  for (const [before, after] of replacements) {
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

test('mounted scroll rejects incomplete, substituted, failed or retried outcomes', () => {
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

test('mounted scroll keeps exact retirement ACKs and finite fractional cutoffs', () => {
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
