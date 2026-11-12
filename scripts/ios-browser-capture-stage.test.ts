import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { parseNativeArguments } from './ios-browser-options.ts'
import { verifyNativeSource } from './ios-browser-source.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'
import { sourceInventory } from './fixtures/ios-browser/source-inventory.ts'

test('capture-control is a closed exact-file positive stage with original clocks', async () => {
  const stage = 'capture-control'
  const selected = nativeStage(stage)
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/capture.json',
  ])
  assert.equal(request.kind, 'run')
  assert(selected.file.endsWith('/scripts/ios-browser-capture-control.browser.test.ts'))
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  const inventory = sourceInventory(selected.file, source)
  const registrations = inventory.map(({ fullName, line, index }) => ({
    fullName,
    sourceKey: `scripts/ios-browser-capture-control.browser.test.ts:${line}:${index}`,
  }))
  assert.equal(registrations.length, 5)
  assert.deepEqual(
    selected.expected.map(({ fullName, sourceKey }) => ({ fullName, sourceKey })),
    registrations,
  )
  assert(selected.expected.every((item) => item.timeoutMs === 15000 && item.retries === 0))
  assert(inventory.every((item) => item.timeoutMs === 15000))
  assert.doesNotMatch(source, /\.rejects|\.skip|\.only|\.todo|expect\.poll/)
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  assert.throws(() =>
    verifyNativeStage(stage, { ...result, cases: result.cases.slice(1) }, receiptFixture),
  )
  assert.throws(() =>
    verifyNativeStage(
      stage,
      { ...result, cases: result.cases.concat(result.cases.slice(0, 1)) },
      receiptFixture,
    ),
  )
})
