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

const stage = 'atlas-registry'
const selected = nativeStage(stage)

test('Atlas registry selects the complete original and its eleven exact case identities', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/atlas-registry.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/render/webgpu/atlas-registry.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'reuses equal descriptors, keeps peers alive and removes listeners on the last release',
      'isolates all fitted font fields and DPR while ignoring property insertion order',
      'retires acquisitions on loading without mutating a live peer atlas',
      'retires acquisitions on loadingdone without mutating a live peer atlas',
      'retires acquisitions on loadingerror without mutating a live peer atlas',
      'detects preloaded same-metric resource replacement before a new owner joins',
      'isolates acquisition after a FontFace ascentOverride mutation',
      'isolates acquisition after a FontFace descentOverride mutation',
      'isolates acquisition after a FontFace lineGapOverride mutation',
      'isolates acquisition after a FontFace display mutation',
      'isolates acquisition after a FontFace sizeAdjust mutation',
    ],
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    [
      'src/render/webgpu/atlas-registry.browser.test.ts:43:0',
      'src/render/webgpu/atlas-registry.browser.test.ts:63:0',
      'src/render/webgpu/atlas-registry.browser.test.ts:90:0',
      'src/render/webgpu/atlas-registry.browser.test.ts:90:1',
      'src/render/webgpu/atlas-registry.browser.test.ts:90:2',
      'src/render/webgpu/atlas-registry.browser.test.ts:103:0',
      'src/render/webgpu/atlas-registry.browser.test.ts:119:0',
      'src/render/webgpu/atlas-registry.browser.test.ts:119:1',
      'src/render/webgpu/atlas-registry.browser.test.ts:119:2',
      'src/render/webgpu/atlas-registry.browser.test.ts:119:3',
      'src/render/webgpu/atlas-registry.browser.test.ts:119:4',
    ],
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('displayed-frame-boundaries').file)
})

test('Atlas registry complete-byte identity rejects any original change', async () => {
  const source = await readFile(selected.file)
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.concat([source, Buffer.from('\n')]))
  await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  await verifyNativeSource(stage)
})

test('Atlas registry result validation rejects missing rows, duplicate IDs and changed outcomes', () => {
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

test('Atlas registry appears in launcher and verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
