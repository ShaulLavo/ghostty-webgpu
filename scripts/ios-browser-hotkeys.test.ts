import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test, vi } from 'vitest'
import { parseNativeArguments } from './ios-browser-options.ts'
import { verifyNativeSource } from './ios-browser-source.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const stage = 'ghostty-keymap'
const selected = nativeStage(stage)

test('keymap selects all 13 original cases, parameter rows, events, hooks and clocks', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/ghostty-keymap.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  assert(selected.file.endsWith('/src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts'))
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'legacy Ghostty Mac keymap > sends five text actions with repeats and consumes releases',
      'kitty Ghostty Mac keymap > sends five text actions with repeats and consumes releases',
      'passes composition and extra modifiers to native encoding',
      'reads the screen-reader flag before each event and preserves browser defaults',
      'allows an empty replacement keymap and keeps appended bindings',
      'clears history and rows above the cursor while preserving the prompt and modes',
      'leaves alternate-screen content and selection intact even with an unconditional clear binding',
      'scrolls by pages and to history edges on mac',
      'scrolls by pages and to history edges on linux',
      'scrolls by pages and to history edges on windows',
      'flushes queued output before placing the prompt at the top',
      'preserves an alternate screen entered by queued output before clear',
      'matches the default clear binding after a queued alternate-screen exit',
    ],
  )
  assert.equal(new Set(selected.expected.map((row) => row.sourceKey)).size, 13)
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  const source = await readFile(selected.file, 'utf8')
  assert(source.includes("describe.each(['legacy', 'kitty'] as const)"))
  assert(source.includes("it.each(['mac', 'linux', 'windows'] as const)"))
  assert(source.includes("vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')"))
  assert(source.includes('terminal.textarea!.dispatchEvent(event)'))
  assert(source.includes('for (const cleanup of cleanups.splice(0).reverse()) cleanup()'))
  assert(source.includes('vi.restoreAllMocks()'))
  assert(source.includes('afterAll(() => runtime.dispose())'))
  assert.equal(source.match(/\bexpect\(/g)?.length, 34)
  assert.equal(source.match(/page\.|userEvent\.|expect\.poll\(/g), null)
})

test('keymap source identity rejects altered bodies, helpers, modifiers, rows and cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ["['legacy', 'kitty']", "['legacy']"],
    ["['mac', 'linux', 'windows']", "['mac']"],
    ['length: 40', 'length: 4'],
    ['length: 60', 'length: 6'],
    ['repeat: true', 'repeat: false'],
    ['isComposing: true', 'isComposing: false'],
    ['dispatchEvent(event)', 'dispatchEvent(new Event(type))'],
    ["mockReturnValue('MacIntel')", "mockReturnValue('Linux')"],
    ['cleanups.splice(0).reverse()', 'cleanups'],
    ['vi.restoreAllMocks()', 'vi.resetAllMocks()'],
    ['runtime.dispose()', 'runtime.createTerminal()'],
    ['terminal.dispose()', 'terminal.clear()'],
    ['await queued', 'await Promise.resolve()'],
    ["it('passes composition", "it.skip('passes composition"],
    ['.toBe(bottom - rows)', '.toBe(bottom)'],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('keymap rejects missing parameter rows, wrong identities, failed outcomes and retries', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (const changes of [
    { exit: 0 },
    { rootBrowserSuiteComplete: true },
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
    {
      cases: result.cases.map((row) => ({
        ...row,
        expected: { ...row.expected, timeoutMs: 20000 },
      })),
    },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'fail' } })) },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })) },
  ])
    assert.throws(() => verifyNativeStage(stage, { ...result, ...changes }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('dom-appearance'), receiptFixture))
})
