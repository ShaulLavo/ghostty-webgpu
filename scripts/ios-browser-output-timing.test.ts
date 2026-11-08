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

const stage = 'output-timing'
const selected = nativeStage(stage)

test('output timing selects the complete renderer and presentation matrix plus the worker', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/output-timing.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/dom/tests/output-timing.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'times auto output with frame presentation from input to the shown frame',
      'times auto output with immediate presentation from input to the shown frame',
      'times canvas2d-fill-text output with frame presentation from input to the shown frame',
      'times canvas2d-fill-text output with immediate presentation from input to the shown frame',
      'reports a later burst separately once output pauses',
      "pairs output with typed input, not with the terminal's own replies",
      'forgets input once the last listener leaves',
      'records nothing while no one listens',
      'times worker output up to the frame notice',
    ],
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    [
      'src/dom/tests/output-timing.browser.test.ts:65:0',
      'src/dom/tests/output-timing.browser.test.ts:65:1',
      'src/dom/tests/output-timing.browser.test.ts:65:2',
      'src/dom/tests/output-timing.browser.test.ts:65:3',
      'src/dom/tests/output-timing.browser.test.ts:97:0',
      'src/dom/tests/output-timing.browser.test.ts:113:0',
      'src/dom/tests/output-timing.browser.test.ts:128:0',
      'src/dom/tests/output-timing.browser.test.ts:140:0',
      'src/dom/tests/output-timing.browser.test.ts:152:0',
    ],
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
})

test('output timing identity protects real waits, payload assertions and reverse cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ["['auto', 'immediate']", "['auto', 'frame']"],
    ['quietMs: 30', 'quietMs: 60'],
    ['await pause(5)', 'await pause(0)'],
    ['await pause(80)', 'await pause(0)'],
    ['expect(result.writes).toBe(2)', 'expect(result.writes).toBe(1)'],
    ['result.presentedAt).toBeUndefined()', 'result.presentedAt).toBeDefined()'],
    ['terminal.diagnostics.rendererBackend', 'undefined'],
    ['dist/worker/entry.js', 'dist/worker/other.js'],
    ['testFontUrl }', 'otherFontUrl }'],
    ['terminals.splice(0).reverse()', 'terminals.splice(0)'],
    ['runtime.dispose()', 'runtime.createTerminal()'],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('output timing rejects a missing worker or matrix row and altered case clocks', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (const cases of [
    result.cases.slice(0, -1),
    result.cases.slice(1),
    result.cases.concat(result.cases.slice(0, 1)),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 20000 } })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })),
  ])
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('mac-keybindings'), receiptFixture))
})

test('output timing appears in both launcher and saved-result verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
