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

const stage = 'glyph-fidelity'
const selected = nativeStage(stage)

test('glyph fidelity selects the complete source original and all four cases', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/glyph-fidelity.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/render/tests/glyph-fidelity.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'keeps alphabetic glyphs and digits on a stable baseline while preserving punctuation and descenders',
      'covers combining text, CJK, and emoji without changing their requested cell span',
      'keeps native wide continuation ownership and transparent cell semantics',
      'fits fractional DPR inputs to one drift-free character and cell grid',
    ],
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    [82, 97, 110, 135].map((line) => `src/render/tests/glyph-fidelity.browser.test.ts:${line}:0`),
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('canvas-rasterizer').file)
})

test('glyph fidelity source identity preserves pixel coverage, native ownership and fractional grid', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    [
      'CanvasGlyphRasterizer({ font: fittedFont(20, 40, 30) })',
      'CanvasGlyphRasterizer({ font: fittedFont(20, 40, 29) })',
    ],
    ['.toBeLessThanOrEqual(1)', '.toBeLessThanOrEqual(2)'],
    ["input('e\\u0301')", "input('e')"],
    ["input('\u754c', 2)", "input('\u754c', 1)"],
    ["input('\ud83e\uddea', 2)", "input('\ud83e\uddea', 1)"],
    ['createNativeTestState(3, 1)', 'createNativeTestState(4, 1)'],
    ['GLYPH_INSTANCE_FLOATS + GlyphOffset.Meta', 'GlyphOffset.Meta'],
    ['builder.cellData[CellOffset.Background + 3]', 'builder.cellData[CellOffset.Background + 2]'],
    ['builder.dispose()', 'void builder'],
    ['[1, 1.25, 1.5, 2, 2.2]', '[1, 2]'],
    ['.toBeCloseTo(font.deviceCellWidth * 200, 10)', '.toBeCloseTo(font.deviceCellWidth * 200, 1)'],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('glyph fidelity saved-result validation rejects missing cases, duplicates and changed options', () => {
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
  assert.throws(() => verifyNativeStage(stage, resultFixture('canvas-rasterizer'), receiptFixture))
})

test('glyph fidelity appears in launcher and saved-result verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
