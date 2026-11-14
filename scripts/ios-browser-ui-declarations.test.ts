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

const stage = 'ui-declarations'
const selected = nativeStage(stage)

test('UI declarations selects the complete composition and worker font rows', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/ui-declarations.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/dom/tests/ui-declarations.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'styles the first visible preedit synchronously and leaves idle appearance untouched',
      'styles the first worker preedit with actor metrics (host font loaded: false)',
      'styles the first worker preedit with actor metrics (host font loaded: true)',
      'restores active preedit after a renderer peer in the same callback',
      'restores priority-only changes to owned preedit and caret declarations',
      'supports active preedit in a supplied inert-document element',
      'releases preedit cache and observer ownership when the optional element disappears',
      'restores caret declarations after exposed inline styles change',
      'restores preedit appearance after exposed inline styles change',
      'restores preedit appearance after a peer callback in the same native frame',
      'applies appearance to a replacement supplied composition element',
      'retains preedit appearance during row edits with unchanged font and theme',
      'keeps owned caret declarations until validated coordinates change',
    ].map((title) => `terminal UI declarations > ${title}`),
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    [
      '124:0',
      '157:0',
      '157:1',
      '211:0',
      '226:0',
      '250:0',
      '259:0',
      '267:0',
      '278:0',
      '286:0',
      '293:0',
      '301:0',
      '338:0',
    ].map((location) => `src/dom/tests/ui-declarations.browser.test.ts:${location}`),
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
})

test('UI declaration identity preserves DOM events, metrics, mutation checks and cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ['it.each([false, true])', 'it.each([true])'],
    ["new CompositionEvent('compositionstart'", "new CompositionEvent('compositionend'"],
    ["inputType: 'insertCompositionText'", "inputType: 'insertText'"],
    ['document.implementation.createHTMLDocument()', 'document'],
    ['face = await new FontFace', 'face = new FontFace'],
    ['dist/worker/entry.js', 'dist/worker/other.js'],
    [
      'expect(terminal.submittedFrame).toBeUndefined()',
      'expect(terminal.submittedFrame).toBeDefined()',
    ],
    ['`${font.cssCellWidth}px`', '`${font.cssCellHeight}px`'],
    ["probe.composition().style.removeProperty('font-size')", 'probe.composition().remove()'],
    ['requestAnimationFrame(() => resolve())', 'queueMicrotask(() => resolve())'],
    [
      "getPropertyPriority('font-size')).toBe('')",
      "getPropertyPriority('font-size')).toBe('important')",
    ],
    ['new MutationObserver', 'new ResizeObserver'],
    ["'preeditAppearance'", "'preeditObserver'"],
    ['expect(styleReads).toHaveBeenCalledTimes(1)', 'expect(styleReads).toHaveBeenCalledTimes(2)'],
    ['Number.NaN', '0'],
    ['cleanups.splice(0).reverse()', 'cleanups.splice(0)'],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('UI declarations rejects missing font branches, mutation cases and altered clocks', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (const cases of [
    result.cases.filter((_row, index) => index !== 1),
    result.cases.filter((_row, index) => index !== 2),
    result.cases.slice(0, -1),
    result.cases.concat(result.cases.slice(0, 1)),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 20000 } })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })),
  ])
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('output-timing'), receiptFixture))
})

test('UI declarations appears in both launcher and saved-result verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
