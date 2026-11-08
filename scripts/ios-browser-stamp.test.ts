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

const stage = 'stamp-cache'
const selected = nativeStage(stage)
const file = 'src/render/pixels/stamp-cache.browser.test.ts'

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

test('stamp cache selects all six original callbacks, source locations and clocks', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/stamp-cache.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  assert.equal(selected.expected.length, 6)
  const registrations = source.split('\n').flatMap((line, index) =>
    line.startsWith('  it(')
      ? [
          {
            fullName: 'Canvas resident stamp cache > ' + line.split("'")[1],
            sourceKey: `${file}:${index + 1}:2`,
          },
        ]
      : [],
  )
  assert.deepEqual(
    selected.expected.map(({ fullName, sourceKey }) => ({ fullName, sourceKey })),
    registrations,
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.equal(source.match(/\bexpect\(/g)?.length, 28)
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

test('stamp cache source gate rejects changed raster inputs, memory, mocks, assertions and registrations', async () => {
  const source = await readFile(selected.file, 'utf8')
  for (const changed of [
    source.replace("font: '20px monospace'", "font: '20px replacement'"),
    source.replace('navigator.userAgent', "'substituted-browser'"),
    source.replace("shape: ['glyph', '👩‍💻', 1.5, 24]", "shape: ['glyph', 'Ag', 1.5, 24]"),
    source.replace('identity({ alpha: 0.5 }),', 'identity({ alpha: 1 }),'),
    source.replace('getImageData(0, 0, 64, 32)', 'getImageData(0, 0, 1, 1)'),
    source.replace('storage.memory.grow(1)', 'storage.memory.grow(0)'),
    source.replace('toHaveBeenCalledOnce()', 'toHaveBeenCalled()'),
    source.replace('toEqual([...source.image.data])', 'toBeDefined()'),
    source.replace(
      'mockReturnValueOnce(storage.memory.buffer.byteLength + 1)',
      'mockReturnValueOnce(0)',
    ),
    source.replace('toHaveLength(1)', 'toHaveLength(0)'),
    source.replace("it('does zero", "it.skip('does zero"),
    source + "\nit('extra case', () => {})\n",
  ]) {
    assert.notEqual(changed, source)
    assert.notEqual(digest(changed), nativeSourceHashes[stage])
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('stamp cache rejects incomplete, substituted, failed or retried outcomes', () => {
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

test('stamp cache keeps exact retirement ACKs and finite fractional cutoffs', () => {
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
