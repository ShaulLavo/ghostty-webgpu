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

const stage = 'canvas-rasterizer'
const selected = nativeStage(stage)
const file = 'src/render/shared/atlas/canvas-rasterizer.browser.test.ts'

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

test('canvas rasterizer selects all eight original callbacks, source locations and clocks', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/canvas-rasterizer.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  assert.equal(selected.expected.length, 8)
  const registrations = source
    .split('\n')
    .flatMap((line, index) =>
      line.startsWith('it(')
        ? [{ fullName: line.split("'")[1], sourceKey: `${file}:${index + 1}:0` }]
        : [],
    )
  assert.deepEqual(
    selected.expected.map(({ fullName, sourceKey }) => ({ fullName, sourceKey })),
    registrations,
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.equal(source.match(/\bexpect\(/g)?.length, 27)
  assert.equal(
    source.match(/\b(?:beforeAll|beforeEach|afterAll|afterEach|onTestFinished)\(/g),
    null,
  )
  assert.equal(
    source.match(
      /\b(?:setTimeout|setInterval|requestAnimationFrame|Date\.now|performance\.now)\(/g,
    ),
    null,
  )
  assert.equal(source.match(/expect\.poll\(/g), null)
})

test('canvas rasterizer source gate rejects changed loops, assertions, fonts and registrations', async () => {
  const source = await readFile(selected.file, 'utf8')
  for (const changed of [
    source.replace('index < 4_096', 'index < 4'),
    source.replace('pixels <= 4 * 1_024 * 1_024', 'pixels <= 1_024'),
    source.replace('[1, 1.25, 1.5, 2, 2.2]', '[1]'),
    source.replace("family: 'monospace'", "family: 'replacement'"),
    source.replace('boldWeight: 900, weight: 300', 'boldWeight: 700, weight: 400'),
    source.replace('toBeLessThanOrEqual(1)', 'toBeLessThanOrEqual(2)'),
    source.replace("expect(emoji.kind).toBe('color')", "expect(emoji.kind).toBe('grayscale')"),
    source.replace('toEqual(first)', 'toBeDefined()'),
    source.replace("it('keeps", "it.skip('keeps"),
    source + "\nit('extra case', () => {})\n",
  ]) {
    assert.notEqual(changed, source)
    assert.notEqual(digest(changed), nativeSourceHashes[stage])
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('canvas rasterizer rejects incomplete, substituted, failed or retried outcomes', () => {
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
  assert.throws(() => verifyNativeStage(stage, resultFixture('font-geometry'), receiptFixture))
  assert.throws(() => verifyNativeStage(stage, result, { ...receiptFixture, exit: 0 }))
})

test('canvas rasterizer keeps exact retirement ACKs and finite fractional cutoffs', () => {
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
