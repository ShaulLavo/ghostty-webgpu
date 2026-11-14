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

const stage = 'gpu-textures'
const selected = nativeStage(stage)

test('GPU textures select the complete original and its three exact case identities', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/gpu-textures.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/render/webgpu/gpu-textures.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'uploads odd-stride dirty rectangles to two layers of each growing texture array',
      'rejects a layer capacity above the adapter limit before allocating textures',
      'starts each kind at one layer and preserves existing pixels when only grayscale grows',
    ],
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    [64, 93, 101].map((line) => `src/render/webgpu/gpu-textures.browser.test.ts:${line}:0`),
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('displayed-frame-boundaries').file)
})

test('GPU texture complete-byte identity rejects any original change', async () => {
  const source = await readFile(selected.file)
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.concat([source, Buffer.from('\n')]))
  await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  await verifyNativeSource(stage)
})

test('GPU texture result validation rejects missing rows, duplicate IDs and changed outcomes', () => {
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

test('GPU textures appear in launcher and verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
