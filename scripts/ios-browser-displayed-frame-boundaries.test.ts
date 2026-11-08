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

const stage = 'displayed-frame-boundaries'
const selected = nativeStage(stage)
const failurePrefix = 'review failure boundaries > '
const gpuRows = [
  { backend: 'webgl', coordinated: false },
  { backend: 'webgpu', coordinated: false },
  { backend: 'webgpu', coordinated: true },
]

function expectedNames(): string[] {
  const failures = [
    'preserves previous lazy accepted text when extraction fails after native capture',
  ].concat(
    ['webgl', 'webgpu'].map(
      (backend) => `recovers ${backend} after acknowledgement fails with populated pending text`,
    ),
    gpuRows
      .map((row) => ({ ...row, failure: 'acknowledge' }))
      .concat([{ backend: 'webgpu', coordinated: true, failure: 'acceptFrame' }])
      .map(
        ({ backend, coordinated, failure }) =>
          `stages ${backend} coordinated=${coordinated} acceptance through ${failure} without prior text demand`,
      ),
    gpuRows.map(
      ({ backend, coordinated }) =>
        `keeps ${backend} coordinated=${coordinated} accepted text through an upload failure without prior text demand`,
    ),
    ['captureRetainedFrame', 'readRetainedText'].map(
      (operation) => `reports and recovers ${operation} failure through coordinated WebGPU commits`,
    ),
    [
      'bounds coordinated failure retries until another render action',
      'defers pre-open text listeners until public operations are available',
      'keeps public renderer onTextFrame snapshots owned after the next capture',
      'keeps public renderer text snapshots cloneable without public native tokens',
    ],
  )
  return failures
    .map((name) => failurePrefix + name)
    .concat([
      'review text publication reentrancy and device recovery > keeps accessibility on the newest frame after a reentrant WebGPU layout update',
      'keeps Y submitted while X notifies with both coordinated WebGPU images committed',
    ])
}

test('displayed-frame boundaries select all 18 current cases with their exact parameter order', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/displayed-frame-boundaries.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(
      new URL('../src/dom/tests/displayed-frame-boundaries.browser.test.ts', import.meta.url),
    ),
  )
  await verifyNativeSource(stage)
  assert.equal(selected.expected.length, 18)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    expectedNames(),
  )
  const groups = [
    [133, 1],
    [148, 2],
    [190, 4],
    [235, 3],
    [269, 2],
    [300, 1],
    [318, 1],
    [335, 1],
    [349, 1],
    [363, 1],
    [412, 1],
  ]
  const keys = groups.flatMap(([line, count]) =>
    Array.from(
      { length: count! },
      (_, index) => `src/dom/tests/displayed-frame-boundaries.browser.test.ts:${line}:${index}`,
    ),
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    keys,
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('canvas-image').file)
})

test('displayed-frame source hashing protects native failures, clocks, callbacks and old/new image oracles', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ['runtime = await GhosttyRuntime.create()', 'runtime = undefined'],
    ['await TerminalSession.create<Event>', 'await Object.create'],
    ['new DeferredClock()', 'undefined'],
    ['const timers = [...this.timers.values()]', 'const timers = []'],
    ['const frames = [...this.frames.values()]', 'const frames = []'],
    ['this.timers.clear()', 'this.frames.clear()'],
    ["Reflect.set(Reflect.get(renderer, 'scheduler'), 'clock', coordinator)", 'clock.flush()'],
    [
      "vi.spyOn(runtime.bridge, 'readRetainedText').mockReturnValue(-1)",
      "vi.spyOn(runtime.bridge, 'readRetainedText').mockReturnValue(0)",
    ],
    ['pending.readTextRows()', 'pending.accept()'],
    ["vi.spyOn(state, 'acknowledge')", "vi.spyOn(state, 'readTextRows')"],
    ["failure: 'acceptFrame'", "failure: 'acknowledge'"],
    ["vi.spyOn(pass, 'uploadFrame')", "vi.spyOn(pass, 'acceptFrame')"],
    ["vi.spyOn(globalThis, 'queueMicrotask')", "vi.spyOn(globalThis, 'setTimeout')"],
    ['microtask.mockRestore()', 'capture.mockRestore()'],
    ['clock.flushTimers()', 'clock.flush()'],
    ['attempt < 6', 'attempt < 1'],
    ['expect(capture).toHaveBeenCalledTimes(2)', 'expect(capture).toHaveBeenCalledTimes(1)'],
    ["terminal.write('from listener')", "terminal.write('different')"],
    ['structuredClone(frame)', 'frame'],
    ['.poll(() =>', '.poll(() => [], { timeout: 20000 })\n      .poll(() =>'],
    [
      'const shared = { clock, coordinator: new FrameCoordinator(clock) }',
      'const shared = undefined',
    ],
    ['subscribeCanvasImage(x.terminal, () => {', 'subscribeCanvasImage(y.terminal, () => {'],
    [".toBe('Y old')", ".toBe('Y new')"],
    ["expect(seen).toEqual([['Y old', '', '', '']])", 'expect(seen).toEqual([])'],
    ['cleanups.splice(0).reverse()', 'cleanups.splice(0)'],
    ['afterAll(() => runtime.dispose())', 'afterAll(() => {})'],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  await verifyNativeSource(stage)
})

test('displayed-frame validation rejects every omitted row, duplicate identity, failure and changed clock', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  const missing: readonly unknown[] = Array.from(result.cases, (_row, index) =>
    result.cases.filter((_item, at) => at !== index),
  )
  const altered = [
    result.cases.concat(result.cases.slice(0, 1)),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 20000 } })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })),
    result.cases.map((row) => ({ ...row, actualId: 'repeated' })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'fail' } })),
  ]
  for (const cases of missing.concat(altered))
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('canvas-image'), receiptFixture))
})

test('displayed-frame stage appears in both supported-host help strings', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
