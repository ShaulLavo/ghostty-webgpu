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

const stage = 'managed-fallback'
const selected = nativeStage(stage)

test('managed fallback selects the complete context-loss original and both termination rows', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/managed-fallback.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/render/tests/fallback.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'managed renderer fallback > replaces a lost WebGL canvas once and paints pending writes through the original callback',
      'managed renderer fallback > applies changes received during replacement before drawing and preserves hidden/focus state',
      'managed renderer fallback > disposes Canvas2D completing after dispose and leaves no scheduled work',
      'managed renderer fallback > disposes Canvas2D completing after abort and leaves no scheduled work',
      'managed renderer fallback > reports a failed replacement once without retrying or leaving scheduled work',
      'reapplies reduced motion changed while a replacement renderer is opening',
    ],
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    ['93:0', '118:0', '165:0', '165:1', '191:0', '211:0'].map(
      (location) => `src/render/tests/fallback.browser.test.ts:${location}`,
    ),
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
})

test('fallback source identity preserves native attachment, browser loss, paint, mocks and cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ['await attachNativeTestBuilder(', 'attachNativeTestBuilder('],
    ["it.each(['dispose', 'abort'] as const)", "it.each(['dispose'] as const)"],
    ['extension.loseContext()', 'canvas.dispatchEvent(new Event("webglcontextlost"))'],
    ['await lost', 'void lost'],
    ['context.getImageData(x, y, 1, 1)', 'context.getImageData(0, 0, 1, 1)'],
    ['schedulerClock: clock', 'schedulerClock: undefined'],
    ['renderer.setDocumentVisible(false)', 'renderer.setDocumentVisible(true)'],
    ["renderer.setInactiveCursorStyle('none')", "renderer.setInactiveCursorStyle('block')"],
    ['renderer.setReducedMotion(true)', 'renderer.setReducedMotion(false)'],
    ['vi.restoreAllMocks()', 'vi.clearAllMocks()'],
    ['for (const renderer of renderers) renderer.dispose()', 'renderers.clear()'],
    ['for (const canvas of canvases) canvas.remove()', 'canvases.clear()'],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('fallback saved-result validation rejects omitted branches, duplicate cases and changed options', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  const missing: readonly unknown[] = Array.from(result.cases, (_row, index) =>
    result.cases.filter((_item, at) => at !== index),
  )
  const altered = [
    result.cases.concat(result.cases.slice(0, 1)),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 20000 } })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })),
  ]
  for (const cases of missing.concat(altered))
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('ui-declarations'), receiptFixture))
})

test('fallback appears in launcher and saved-result verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
