import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'
import { parseNativeArguments } from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { nativeSourceHashes, verifyNativeSource } from './ios-browser-source.ts'
import { parseHostSummary, joinedExit } from './ios-browser-result.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'

const files = [
  {
    stage: 'write-queue',
    sites: [
      [43, 0],
      [58, 0],
      [79, 0],
      [97, 0],
      [114, 0],
    ],
    hooks: ['afterEach('],
  },
  {
    stage: 'presentation',
    sites: [
      [37, 0],
      [37, 1],
      [57, 0],
    ],
    hooks: ['beforeAll(', 'afterEach(', 'afterAll('],
  },
  { stage: 'scrollbar-async', sites: [[11, 0]], hooks: ['afterEach('] },
  {
    stage: 'history',
    sites: [
      [29, 0],
      [29, 1],
      [117, 0],
      [125, 0],
      [151, 0],
    ],
    hooks: ['afterEach('],
  },
  {
    stage: 'readline-layout',
    sites: [
      [71, 0],
      [93, 0],
    ],
    hooks: ['afterEach('],
  },
] as const

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('the ownership stages bind complete original files, hooks, source sites and public types', async () => {
  for (const { stage, sites, hooks } of files) {
    const selected = nativeStage(stage)
    const expected: readonly ExpectedCase[] = selected.expected
    const path = `src/dom/tests/${stage}.browser.test.ts`
    assert(selected.file.endsWith('/' + path))
    await verifyNativeSource(stage)
    const source = await readFile(selected.file, 'utf8')
    assert.equal(sha256(Buffer.from(source)), nativeSourceHashes[stage])
    assert.deepEqual(
      expected.map((row) => row.sourceKey),
      sites.map(([line, ordinal]) => `${path}:${line}:${ordinal}`),
    )
    assert.deepEqual(source.match(/\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/g), hooks)
    assert(
      expected.every(
        (row) => row.file === selected.file && row.timeoutMs === 15000 && row.retries === 0,
      ),
    )
    const request = parseNativeArguments([
      '--stage',
      stage,
      '--udid',
      '00000000-0000-0000-0000-000000000000',
      '--result',
      `/not-executed/${stage}.json`,
    ])
    assert.equal(request.kind, 'run')
    if (request.kind !== 'run') throw new Error('Expected explicit stage')
    assert.equal(request.options.stage, stage)
    assert.throws(() =>
      parseNativeArguments([
        '--stage',
        `${stage}-extra`,
        '--udid',
        '00000000-0000-0000-0000-000000000000',
        '--result',
        `/not-executed/${stage}.json`,
      ]),
    )
  }
})

test('the batch retains original clocks, cleanup loops, synthetic event and real Wasm bytes', async () => {
  const write = await readFile(nativeStage('write-queue').file, 'utf8')
  assert(write.includes('const deadline = Date.now() + 5_000'))
  assert(write.includes('setTimeout(resolve, 10)'))
  assert(write.includes('for (const cleanup of active.splice(0)) await cleanup()'))
  const presentation = await readFile(nativeStage('presentation').file, 'utf8')
  assert(presentation.includes('for (let frame = 0; frame < 2; frame += 1)'))
  assert(presentation.includes('requestAnimationFrame(resolve)'))
  assert(
    presentation.includes(
      'for (const terminal of terminals.splice(0).reverse()) await terminal.dispose()',
    ),
  )
  const scroll = await readFile(nativeStage('scrollbar-async').file, 'utf8')
  assert(scroll.includes("new WheelEvent('wheel', { cancelable: true, deltaMode: 1, deltaY: -1 })"))
  assert(scroll.includes('for (const cleanup of cleanups.splice(0).reverse()) cleanup()'))
  assert.equal(scroll.match(/await Promise\.resolve\(\)/g)?.length, 2)
  for (const [path, digest] of [
    ['ghostty-vt.wasm', 'de411c7abb6af40aa9c077b79c373cf11952e7801133d0855cdf3723be5b1426'],
    ['bridge.wasm', '3629e4a60d5404a4ebab476e488fe8834074e838c85c9ab488ffca8501a7ede0'],
  ] as const) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url))
    assert.equal(bytes.subarray(0, 4).toString('hex'), '0061736d')
    assert.equal(sha256(bytes), digest)
  }
})

test('every batch result rejects omitted, duplicated, renamed, substituted or failed cases', () => {
  for (const { stage } of files) {
    const result = resultFixture(stage)
    verifyNativeStage(stage, result, receiptFixture)
    const first = result.cases[0]
    assert.ok(first)
    const wrong = [
      { fullName: 'renamed case' },
      { sourceKey: 'substituted source' },
      { file: '/substituted/file.browser.test.ts' },
      { timeoutMs: 1 },
      { retries: 1 },
    ]
    for (const change of wrong) {
      const cases = result.cases.map((row) => ({
        ...row,
        expected: { ...row.expected, ...change },
      }))
      assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
    }
    assert.throws(() =>
      verifyNativeStage(stage, { ...result, cases: result.cases.slice(1) }, receiptFixture),
    )
    assert.throws(() =>
      verifyNativeStage(stage, { ...result, cases: result.cases.concat(first) }, receiptFixture),
    )
    const cases = result.cases.map((row) => ({ ...row, started: false }))
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
    const failed = { ...result, exit: 1, framework: { status: 'failed' } }
    assert.equal(parseHostSummary(failed).framework, 'failed')
    assert.equal(
      joinedExit({ kind: 'exited', code: 1, signal: null, joined: true }, parseHostSummary(failed)),
      1,
    )
    assert.throws(() => verifyNativeStage(stage, failed, receiptFixture))
    assert.throws(() =>
      verifyNativeStage(stage, { ...result, rootBrowserSuiteComplete: true }, receiptFixture),
    )
    assert.throws(() => verifyNativeStage(stage, resultFixture('measurement'), receiptFixture))
  }
})

test('batch verification preserves fractional cutoffs but requires safe equal ACKs and zero pending', () => {
  for (const { stage } of files) {
    const result = resultFixture(stage)
    verifyNativeStage(stage, result, receiptFixture)
    const changes = [
      { acceptedThrough: 0.5, ackedThrough: 0.5 },
      { acceptedThrough: Number.MAX_SAFE_INTEGER + 1, ackedThrough: Number.MAX_SAFE_INTEGER + 1 },
      { acceptedThrough: 4, ackedThrough: 3 },
      { pending: 1 },
      { cutoff: -1 },
      { cutoff: Infinity },
      { cutoff: NaN },
    ]
    for (const change of changes) {
      const documents = result.documents.map((document) => ({ ...document, ...change }))
      assert.throws(() => verifyNativeStage(stage, { ...result, documents }, receiptFixture))
    }
  }
})
