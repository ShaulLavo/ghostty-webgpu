import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, vi } from 'vitest'
import { nativeUsage, parseNativeArguments, type NativeStage } from './ios-browser-options.ts'
import { nativeSourceHashes, verifyNativeSource } from './ios-browser-source.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const root = fileURLToPath(new URL('../', import.meta.url))
const suites = [
  {
    stage: 'legacy-text',
    file: 'bench/comparison-legacy-text.browser.test.ts',
    hash: '3335534124bd8eb476e9e66c6e93028d31a33532354c009c5a54dbec10cdcf70',
    sites: ['18:0', '37:0'],
    replacements: [
      ['afterEach(() => {', 'afterEach(() => { /* changed hook */'],
      [
        "vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText')",
        "vi.spyOn(CanvasRenderingContext2D.prototype, 'clearRect')",
      ],
      ["toBe('wide 日本語 é')", "toBe('substitute')"],
      ['element: host,', 'element: host, save: false,'],
      ['../.artifacts/bench-legacy-graphemes.png', '../.artifacts/other.png'],
      ['terminal?.dispose()', 'terminal?.clear()'],
    ],
  },
  {
    stage: 'pointer-selection',
    file: 'src/dom/tests/pointer-selection.browser.test.ts',
    hash: 'd1504dac38906a9dbe6d0326ed390350ed94aa4201a381ec20a5c8f464b65b6e',
    sites: [
      '296:0',
      '328:0',
      '380:0',
      '420:0',
      '443:0',
      '493:0',
      '530:0',
      '541:0',
      '564:0',
      '580:0',
      '598:0',
      '638:0',
      '671:0',
      '698:0',
    ],
    replacements: [
      ['new FakeSelectionClock()', 'new DifferentClock()'],
      ['1_000_000_000n', '1n'],
      ['harness.clock.flushInterval()', 'harness.clock.advance(1)'],
      ['pixelRatio: 2,', 'pixelRatio: 1,'],
      [
        "canvas.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId }))",
        "canvas.dispatchEvent(new Event('lostpointercapture'))",
      ],
      ['expect(harness.clock.timers.size).toBe(0)', 'expect(harness.clock.timers.size).toBe(1)'],
      ['pointer.dispose()', 'selection.clear()'],
      ['cleanups.splice(0).reverse()', 'cleanups.splice(0)'],
    ],
  },
  {
    stage: 'hotkeys-focus',
    file: 'src/extensions/hotkeys/tests/focus.browser.test.ts',
    hash: '65997947caf99d9a13a55d6828547965c4aa6fd50d59ed7469eddfd443736901',
    sites: [
      '136:0',
      '146:0',
      '146:1',
      '146:2',
      '184:0',
      '184:1',
      '218:0',
      '218:1',
      '249:0',
      '268:0',
      '313:0',
      '341:0',
      '386:0',
      '407:0',
      '407:1',
      '407:2',
      '407:3',
      '436:0',
      '436:1',
      '436:2',
      '525:0',
    ],
    replacements: [
      ["['main']", "['worker']"],
      ["['invalid', 'resolved', 'rejected']", "['invalid', 'resolved']"],
      ["['blur', 'hidden', 'releaseAll', 'dispose']", "['blur']"],
      ["['linux', 'windows', 'mac']", "['linux']"],
      ['DomTerminalRenderer.create(options)', 'OtherRenderer.create(options)'],
      ['await cleanup()', 'cleanup()'],
      ['restoreRendererNavigator()', 'vi.unstubAllGlobals()'],
      ["scale: 'css'", "scale: 'device'"],
      ['../../../../.artifacts/terminal205-${entry}.png', '../../../../.artifacts/other.png'],
      ["expect(f.output).toEqual(['汉字'])", 'expect(f.output).toHaveLength(1)'],
    ],
  },
] satisfies {
  stage: NativeStage
  file: string
  hash: string
  sites: string[]
  replacements: [string, string][]
}[]

test.each(suites)(
  '$stage selects the complete unchanged file with exact locations and clocks',
  async ({ stage, file, hash, sites }) => {
    const request = parseNativeArguments([
      '--stage',
      stage,
      '--udid',
      '00000000-0000-0000-0000-000000000000',
      '--result',
      `/not-executed/${stage}.json`,
    ])
    assert.equal(request.kind, 'run')
    assert(request.kind === 'run')
    assert.equal(request.options.stage, stage)
    const selected = nativeStage(stage)
    assert.equal(selected.file, join(root, file))
    assert.equal(nativeSourceHashes[stage], hash)
    await verifyNativeSource(stage)
    assert.deepEqual(
      selected.expected.map((row) => row.sourceKey),
      sites.map((site) => `${file}:${site}`),
    )
    assert(
      selected.expected.every(
        (row) => row.file === selected.file && row.timeoutMs === 15000 && row.retries === 0,
      ),
    )
    const source = await readFile(selected.file, 'utf8')
    assert(!/page\.viewport|userEvent\.|\b(?:it|describe)\.(?:skip|only)/.test(source))
    const runner = await readFile(new URL('./ios-browser-run.ts', import.meta.url), 'utf8')
    assert(runner.includes('testTimeout: 15000,\n      hookTimeout: 30000,\n      retry: 0,'))
  },
)

test.each(suites)(
  '$stage rejects altered original hooks, assertions, fixtures and cleanup',
  async ({ stage, replacements }) => {
    const source = await readFile(nativeStage(stage).file, 'utf8')
    const mutations = replacements
      .map(([before, after]) => {
        const changed = source.replace(before, after)
        assert.notEqual(changed, source, before)
        return changed
      })
      .concat([source + '\n', source.replace(/\bit\(/, 'it.skip(')])
    for (const changed of mutations) {
      vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
      await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
    }
    await verifyNativeSource(stage)
  },
)

function invalidCases(stage: NativeStage): unknown[] {
  const { cases } = resultFixture(stage)
  const mutate = (change: (row: (typeof cases)[number]) => unknown) => cases.map(change)
  return [
    null,
    [],
    mutate(() => null),
    mutate(() => ({})),
    cases.concat(cases.slice(0, 1)),
    mutate((row) => ({ ...row, expected: null })),
    mutate((row) => ({ ...row, expected: { ...row.expected, file: 'other' } })),
    mutate((row) => ({ ...row, expected: { ...row.expected, fullName: 'other' } })),
    mutate((row) => ({ ...row, expected: { ...row.expected, sourceKey: 'other' } })),
    mutate((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 20000 } })),
    mutate((row) => ({ ...row, expected: { ...row.expected, retries: 1 } })),
    mutate((row) => ({ ...row, actualId: 'repeated' })),
    mutate((row) => ({ ...row, started: false })),
    mutate((row) => ({ ...row, outcome: null })),
    mutate((row) => ({ ...row, outcome: { ...row.outcome, id: 'other' } })),
    mutate((row) => ({ ...row, outcome: { ...row.outcome, state: 'fail' } })),
    mutate((row) => ({ ...row, outcome: { ...row.outcome, state: 'skip' } })),
    mutate((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })),
  ]
}

test.each(suites)(
  '$stage requires every case and rejects malformed, substituted or failed results',
  ({ stage }) => {
    const result = resultFixture(stage)
    verifyNativeStage(stage, result, receiptFixture)
    for (let index = 0; index < result.cases.length; index++)
      assert.throws(() =>
        verifyNativeStage(
          stage,
          { ...result, cases: result.cases.filter((_row, at) => at !== index) },
          receiptFixture,
        ),
      )
    for (const cases of invalidCases(stage))
      assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
    for (const changes of [
      { rootBrowserSuiteComplete: true },
      { cleanup: {} },
      { failures: ['failed hook'] },
      { fileComplete: false },
    ])
      assert.throws(() => verifyNativeStage(stage, { ...result, ...changes }, receiptFixture))
    assert.throws(() => verifyNativeStage(stage, result, { ...receiptFixture, exit: 0 }))
    assert.throws(() => verifyNativeStage(stage, resultFixture('synthetic'), receiptFixture))
  },
)

test('launcher and saved-result verifier list all three stages in the same order', async () => {
  const source = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = source.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  for (const { stage } of suites) {
    assert(usage.split('|').includes(stage))
    assert.throws(() =>
      parseNativeArguments([
        '--stage',
        `${stage}-subset`,
        '--udid',
        '00000000-0000-0000-0000-000000000000',
        '--result',
        '/not-executed/result.json',
      ]),
    )
  }
})
