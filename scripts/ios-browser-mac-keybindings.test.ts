import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

const stage = 'mac-keybindings'
const selected = nativeStage(stage)

test('mac keybindings selects all eight cases including both worker protocol rows', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/mac-keybindings.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  assert(selected.file.endsWith('/src/dom/tests/mac-keybindings.browser.test.ts'))
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    [
      'preserves synchronous key hook ordering and screen-reader browser defaults',
      'main macOS core without a keymap > encodes Cmd+Left through VT in legacy mode',
      'main macOS core without a keymap > encodes Cmd+Left through VT in kitty mode',
      'worker macOS core without a keymap > encodes Cmd+Left through VT in legacy mode',
      'worker macOS core without a keymap > encodes Cmd+Left through VT in kitty mode',
      'keeps linux keys on the VT encoder path',
      'keeps windows keys on the VT encoder path',
      'honors claims, disabled input, composition, extra modifiers, and key hooks',
    ],
  )
  assert.equal(new Set(selected.expected.map((row) => row.sourceKey)).size, 8)
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  const source = await readFile(selected.file, 'utf8')
  for (const literal of [
    "describe.each(['main', 'worker'] as const)",
    "it.each(['legacy', 'kitty'] as const)",
    "it.each(['linux', 'windows'] as const)",
    "'../../../dist/worker/index.js'",
    "new URL('../../../dist/worker/entry.js', import.meta.url)",
    "fonts: [{ family: 'MacKeybindingTest', source: { url: testFontUrl } }]",
    "vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')",
    'await expect.poll(() => output).toEqual([expected])',
    'for (const terminal of terminals.splice(0)) await terminal.dispose()',
    'for (const host of hosts.splice(0)) host.remove()',
    'afterAll(() => runtime.dispose())',
  ])
    assert(source.includes(literal), literal)
  assert.equal(source.match(/page\.|userEvent\.|useFakeTimers|setSystemTime/g), null)
})

test('mac keybindings identity rejects changes to workers, assets, hooks, assertions and cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ["['main', 'worker']", "['main']"],
    ["['legacy', 'kitty']", "['legacy']"],
    ["['linux', 'windows']", "['linux']"],
    ['dist/worker/entry.js', 'dist/worker/other.js'],
    ['ghostty-vt.wasm', 'other.wasm'],
    ['bridge.wasm', 'other-bridge.wasm'],
    ['source: { url: testFontUrl }', 'source: { url: "other.woff2" }'],
    ['screenReaderMode: () => true', 'screenReaderMode: () => false'],
    ["mockReturnValue('MacIntel')", "mockReturnValue('Linux')"],
    ['expect.poll(() => output)', 'expect.poll(() => [])'],
    [".not.toBe('\\x01')", ".toBe('\\x01')"],
    ['isComposing: true', 'isComposing: false'],
    ['await terminal.dispose()', 'await terminal.reset()'],
    ['vi.restoreAllMocks()', 'vi.resetAllMocks()'],
    ['runtime.dispose()', 'runtime.createTerminal()'],
    ["it('honors claims", "it.skip('honors claims"],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('mac keybindings rejects missing worker rows, altered identities and malformed results', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (const changes of [
    { exit: 0 },
    { rootBrowserSuiteComplete: true },
    { cases: result.cases.filter((row) => !row.expected.fullName.startsWith('worker ')) },
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
  assert.throws(() => verifyNativeStage(stage, resultFixture('ghostty-keymap'), receiptFixture))
})

test('launcher and verifier usage list every accepted stage including both keybinding suites', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  for (const name of usage.split('|')) {
    assert(nativeUsage.includes(name))
    assert.equal(
      parseNativeArguments([
        '--stage',
        name,
        '--udid',
        '00000000-0000-0000-0000-000000000000',
        '--result',
        '/not-executed/result.json',
      ]).kind,
      'run',
    )
  }
  assert(usage.split('|').includes('ghostty-keymap'))
  assert(usage.split('|').includes(stage))
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
})
