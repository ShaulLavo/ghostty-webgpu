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

const stage = 'shared-atlas'
const selected = nativeStage(stage)

test('Shared atlas selects the complete original and its sixteen exact case identities', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/shared-atlas.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/render/tests/shared-atlas.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'shares one atlas texture set between terminals with equal fonts and keeps their pixels',
      'moves only the terminal whose font changes and leaves its peers drawing the shared atlas',
      'rebuilds a sharing terminal from its own eviction queue after a peer clears the atlas',
      'restores one terminal on a replacement device while its peer keeps the original device',
      'keeps different DPR and font descriptors in different atlas sets',
      'releases textures only when the last sharing terminal is disposed',
      'keeps the previous texture alive through growth until the coordinator submits its peer',
      'keeps the previous texture alive through invalidation until the coordinator submits its peer',
      'restores all sharing terminals after real device loss with one fresh texture generation',
      'keeps the prior font and releases a new owner when font texture allocation fails',
      'releases retired textures when the invalidating sharer disposes before repaint and its peer stays idle',
      'releases idle-device textures during growth while another device has an encoded frame',
      'releases idle-device textures during invalidation while another device has an encoded frame',
      'keeps the final device lease alive until its encoded owner is submitted',
      'keeps the final device lease alive until its encoded owner is failed',
      'keeps the final device lease alive until its encoded owner is detached',
    ],
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    [
      'src/render/tests/shared-atlas.browser.test.ts:230:0',
      'src/render/tests/shared-atlas.browser.test.ts:244:0',
      'src/render/tests/shared-atlas.browser.test.ts:264:0',
      'src/render/tests/shared-atlas.browser.test.ts:276:0',
      'src/render/tests/shared-atlas.browser.test.ts:294:0',
      'src/render/tests/shared-atlas.browser.test.ts:304:0',
      'src/render/tests/shared-atlas.browser.test.ts:328:0',
      'src/render/tests/shared-atlas.browser.test.ts:328:1',
      'src/render/tests/shared-atlas.browser.test.ts:398:0',
      'src/render/tests/shared-atlas.browser.test.ts:415:0',
      'src/render/tests/shared-atlas.browser.test.ts:433:0',
      'src/render/tests/shared-atlas.browser.test.ts:460:0',
      'src/render/tests/shared-atlas.browser.test.ts:460:1',
      'src/render/tests/shared-atlas.browser.test.ts:512:0',
      'src/render/tests/shared-atlas.browser.test.ts:512:1',
      'src/render/tests/shared-atlas.browser.test.ts:512:2',
    ],
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('displayed-frame-boundaries').file)
})

test('Shared atlas complete-byte identity rejects any original change', async () => {
  const source = await readFile(selected.file)
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.concat([source, Buffer.from('\n')]))
  await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  await verifyNativeSource(stage)
})

test('Shared atlas result validation rejects missing rows, duplicate IDs and changed outcomes', () => {
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

test('Shared atlas appears in launcher and verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
