import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, vi } from 'vitest'
import { createFrameworkHost } from 'waffle/testing/page-runner/framework'
import { nativeUsage, parseNativeArguments, isNativeStage } from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { nativeSourceHashes, verifyNativeSource } from './ios-browser-source.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { sourceInventory } from './fixtures/ios-browser/source-inventory.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const root = fileURLToPath(new URL('../', import.meta.url))
const stages = [
  [
    'canvas-theme-cache',
    'canvas/theme-cache',
    1,
    '6b84137d0b0c083257806bf61c94b0aae0de816e3877f1313615e8822b711163',
  ],
  [
    'canvas-zwj',
    'canvas/zwj',
    10,
    '3d79a6f37c2c82dd2ecdab524110db44a8e12cb0adef9bc199546834681b3393',
  ],
  [
    'pixels',
    'pixels/pixels',
    17,
    '19e262a6c888acaa94b27f63e2c0d254a31265e062d788383520a9d591099f1e',
  ],
  [
    'glyph-constraints',
    'shared/atlas/glyph-constraints',
    4,
    '9f05fa19c21785d96096d21c34541c97e8b9807159858a376c51f3eebeb1f592',
  ],
  [
    'sprites',
    'shared/atlas/sprites',
    12,
    '8c2315f259f95962b455ac05d0eb9ad627fca5d0ee2b8190a8dd02900ca554d3',
  ],
  [
    'displayed-pixels-fixture',
    'webgl/tests/fixture',
    1,
    'bf1a8296342bb21c73db9bb6b360ac212e91592cb9f1667425e6fbc28c924a68',
  ],
] as const

for (const [stage, path, count, hash] of stages) {
  test(`${stage} selects the complete unchanged source with original titles, locations and clocks`, async () => {
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
    assert(isNativeStage(stage))
    const selected = nativeStage(stage)
    assert.equal(relative(root, selected.file), `src/render/${path}.browser.test.ts`)
    assert.equal(selected.expected.length, count)
    assert.equal(nativeSourceHashes[stage], hash)
    await verifyNativeSource(stage)
    const source = await readFile(selected.file, 'utf8')
    const inventory = sourceInventory(selected.file, source)
    assert.deepEqual(
      selected.expected,
      inventory.map(({ fullName, line, index, timeoutMs }) => ({
        file: selected.file,
        fullName,
        sourceKey: `src/render/${path}.browser.test.ts:${line}:${index}`,
        timeoutMs,
        retries: 0,
      })),
    )
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(source + '\n'))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
    await verifyNativeSource(stage)
  })

  test(`${stage} rejects every omitted row and malformed or failed result`, () => {
    const result = resultFixture(stage)
    verifyNativeStage(stage, result, receiptFixture)
    for (let index = 0; index < count; index++) {
      const cases = result.cases.filter((_row, at) => at !== index)
      assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
    }
    const mutations: unknown[] = [
      null,
      {},
      { ...result, cases: null },
      { ...result, cases: result.cases.concat(result.cases.slice(0, 1)) },
      { ...result, cases: result.cases.map(() => null) },
      { ...result, cases: result.cases.map((row) => ({ ...row, expected: {} })) },
      { ...result, cleanup: {} },
      { ...result, fileComplete: false },
      { ...result, rootBrowserSuiteComplete: true },
      { ...result, failures: ['failure'] },
    ]
    for (const mutation of mutations)
      assert.throws(() => verifyNativeStage(stage, mutation, receiptFixture))
    for (const row of result.cases) rejectCaseMutations(stage, result, row)
    assert.throws(() =>
      verifyNativeStage(stage, result, {
        exit: 4,
        outcome: { kind: 'exited', code: 0, joined: true, signal: null },
      }),
    )
  })
}

function rejectCaseMutations(
  stage: (typeof stages)[number][0],
  result: ReturnType<typeof resultFixture>,
  row: ReturnType<typeof resultFixture>['cases'][number],
): void {
  const identities = [
    { ...row.expected, file: '/substitute.ts' },
    { ...row.expected, fullName: 'substitute' },
    { ...row.expected, sourceKey: 'other:1:0' },
    { ...row.expected, timeoutMs: row.expected.timeoutMs + 1 },
    { ...row.expected, retries: 1 },
  ]
  const mutations: unknown[] = identities
    .map<unknown>((expected) => ({ ...row, expected }))
    .concat([
      { ...row, actualId: '' },
      { ...row, started: false },
      { ...row, outcome: null },
      { ...row, outcome: { ...row.outcome, state: 'fail' } },
      { ...row, outcome: { ...row.outcome, state: 'skip' } },
      { ...row, outcome: { ...row.outcome, retryCount: 1 } },
      { ...row, outcome: { ...row.outcome, id: 'wrong-id' } },
    ])
  for (const mutation of mutations) {
    const cases = result.cases.map((item) => (item === row ? mutation : item))
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
  }
}

test('raster extraction rejects changed tables, titles, clocks and modified registrations', async () => {
  for (const [stage] of stages) await rejectSourceMutations(stage)
})

async function rejectSourceMutations(stage: (typeof stages)[number][0]): Promise<void> {
  const { file } = nativeStage(stage)
  const source = await readFile(file, 'utf8')
  const inventory = sourceInventory(file, source)
  const mutations = [
    source.replace(/\bit\(/, 'it.skip('),
    source.replace('it.each(', 'it.only.each('),
    source.replace("{ name: 'family',", "{ name: 'other',"),
    source.replace('it.each([1, 2])', 'it.each([1])'),
    source.replace('[13, 27],', '[14, 27],'),
    source.replace('60_000)', '15_000)'),
    source.replace('}, 20000)', '}, 15000)'),
    source.replace('keeps neighbor widths', 'changes neighbor widths'),
    source.replace('maps a fractional padded screenshot', 'maps a different screenshot'),
    source + "\nit('extra case', () => {})\n",
  ].filter((changed) => changed !== source)
  for (const changed of mutations) {
    assert.notEqual(createHash('sha256').update(changed).digest('hex'), nativeSourceHashes[stage])
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
    assert.throws(() => assert.deepEqual(sourceInventory(file, changed), inventory))
  }
}

test('raster clocks remain authored overrides with unchanged default hooks and retries', async () => {
  assert.deepEqual(
    stages.map(([stage]) => nativeStage(stage).expected.map((row) => row.timeoutMs)),
    [
      [20000],
      Array(10).fill(15000),
      Array(17).fill(15000),
      [15000, 15000, 15000, 60000],
      Array(9).fill(15000).concat([60000, 15000, 15000]),
      [15000],
    ],
  )
  const runner = await readFile(new URL('./ios-browser-run.ts', import.meta.url), 'utf8')
  assert(runner.includes('testTimeout: 15000,\n      hookTimeout: 30000,\n      retry: 0,'))
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  for (const [stage] of stages) assert(usage?.split('|').includes(stage))
})

test('registration extraction never invokes original bodies and rejects malformed clocks and tables', () => {
  const body = '() => { throw new Error("must not execute") }'
  assert.deepEqual(sourceInventory('case.ts', `it('original', ${body}, 60000)`), [
    { fullName: 'original', line: 1, index: 0, timeoutMs: 60000 },
  ])
  for (const source of [
    `it('bad', ${body}, 0)`,
    `it('bad', ${body}, -1)`,
    `it('bad', ${body}, Infinity)`,
    `it('bad', { retry: 1 }, ${body})`,
    `it.each([])('bad %s', ${body})`,
    `it.each([null])('bad %s', ${body})`,
    `it.each([1])('bad %i', ${body})`,
    `it.each([{ name: 'one' }])('bad $missing', ${body})`,
    `it.skip('bad', ${body})`,
    "it('unterminated",
  ])
    assert.throws(() => sourceInventory('case.ts', source))
})

test('the pinned public host admits every authored raster clock without running or allocating a native session', () => {
  for (const [stage] of stages) {
    const selected = nativeStage(stage)
    const options = {
      suite: `ghostty-${stage}`,
      native: { udid: '00000000-0000-0000-0000-000000000000' },
      expected: selected.expected,
      scope: { kind: 'root-selection', command: 'test:browser', files: [selected.file] },
      resultPath: `/not-executed/${stage}.json`,
    } satisfies Parameters<typeof createFrameworkHost>[0]
    assert.doesNotThrow(() => createFrameworkHost(options))
    for (const timeoutMs of [0, -1, NaN, Infinity])
      assert.throws(
        () =>
          createFrameworkHost({
            ...options,
            expected: selected.expected.map((row) => ({ ...row, timeoutMs })),
          }),
        /original clock/,
      )
    assert.throws(
      () =>
        Reflect.apply(createFrameworkHost, undefined, [
          {
            ...options,
            expected: selected.expected.map((row) => ({ ...row, retries: 1 })),
          },
        ]),
      /original clock/,
    )
  }
})

test('contact-sheet inventories and the original displayed-pixel oracle remain intact', async () => {
  for (const [path, cases, codepoints] of [
    ['constraint-fixtures', 18, 24],
    ['sprite-fixtures', 37, 492],
  ] as const) {
    const file = new URL(`../src/render/shared/atlas/${path}/manifest.json`, import.meta.url)
    const manifest: unknown = JSON.parse(await readFile(file, 'utf8'))
    assert(
      manifest && typeof manifest === 'object' && 'cases' in manifest && 'codepoints' in manifest,
    )
    assert(Array.isArray(manifest.cases) && Array.isArray(manifest.codepoints))
    assert.equal(manifest.cases.length, cases)
    assert.equal(manifest.codepoints.length, codepoints)
  }
  const helper = await readFile(new URL('../src/render/webgl/tests/fixture.ts', import.meta.url))
  assert.equal(
    createHash('sha256').update(helper).digest('hex'),
    'f8cda88300bb29bcb53b0f567ede9b2b013b96ba31cfb0a3ed368ace5ab68b03',
  )
})
