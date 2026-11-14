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

const stage = 'text-pass'
const selected = nativeStage(stage)

test('Text pass selects the complete original and both binding-budget rows', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/text-pass.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/render/tests/text-pass.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'binds the small grid on default device limits',
      'binds the largest grid in the packed binding budg… on default device limits',
      'renders transparent defaults, opaque explicit colors, glyphs, and an outline cursor',
      'renders identical native glyph pixels across bounded storage batches',
      'renders explicit cursor text over a WebGPU block cursor',
      'renders decorations, inverse, selection, invisibility, and minimum contrast in shader',
      'selects the native color-atlas kind alongside grayscale glyphs',
      'renders identical atlas coordinates from two layers in one two-draw frame',
      'remaps physical storage rows with exact pixels after ring wrap and regional moves',
    ],
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    ['106:0', '106:1', '307:0', '334:0', '349:0', '380:0', '424:0', '457:0', '501:0'].map(
      (key) => `src/render/tests/text-pass.browser.test.ts:${key}`,
    ),
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('displayed-frame-boundaries').file)
})

test('Text pass complete-byte identity rejects any original change', async () => {
  const source = await readFile(selected.file)
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.concat([source, Buffer.from('\n')]))
  await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  await verifyNativeSource(stage)
})

test('Text pass result validation rejects missing rows, duplicate IDs and changed outcomes', () => {
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
  assert.throws(() => verifyNativeStage(stage, resultFixture('canvas-image'), receiptFixture))
})

test('Text pass appears in launcher and verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
