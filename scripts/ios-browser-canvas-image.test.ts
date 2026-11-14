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

const stage = 'canvas-image'
const selected = nativeStage(stage)
const gpu = ['webgl2', 'webgpu-direct', 'webgpu-coordinated']
const published = gpu.concat(['canvas2d'])
const booleans = ['false', 'true']

function expectedNames(): string[] {
  return gpu
    .concat(['canvas2d', 'pixels'])
    .map(
      (backend) =>
        `copies an accepted complete image synchronously on ${backend}, including transparent erasure`,
    )
    .concat(
      gpu.map((backend) => `keeps the image for source no-submit publications on ${backend}`),
      ['webgpu-direct', 'webgpu-coordinated'].map(
        (backend) => `does not publish a failed ${backend} submit and captures recovery`,
      ),
      ['never acknowledges DOM as a canvas-image publisher'],
      booleans.map(
        (listen) => `preserves expected public rows and observer order, image subscriber=${listen}`,
      ),
      [
        'notifies a clear-only full WebGL rebuild even when no instances draw',
        'stops image and public delivery immediately when an image listener disposes the terminal',
      ],
      booleans.map(
        (listen) => `preserves deterministic blink publications, image subscriber=${listen}`,
      ),
      ['reports a foreign-realm listener rejection once without an unhandled rejection'],
      published.flatMap((backend) => previousImageNames(backend)),
      published.map(
        (backend) => `records metadata before listener writes through built dist on ${backend}`,
      ),
    )
}

function previousImageNames(backend: string): string[] {
  return booleans.flatMap((damaged) =>
    booleans.map(
      (cached) =>
        `reads the previous published image on ${backend}, damaged ${damaged}, cached ${cached}`,
    ),
  )
}

test('canvas-image selects the complete original and all 38 backend and parameter rows', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/canvas-image.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(
    selected.file,
    fileURLToPath(new URL('../src/dom/tests/canvas-image.browser.test.ts', import.meta.url)),
  )
  await verifyNativeSource(stage)
  assert.equal(selected.expected.length, 38)
  assert.deepEqual(
    selected.expected.map((row) => row.fullName),
    expectedNames(),
  )
  const groups = [
    [93, 5],
    [137, 3],
    [162, 2],
    [192, 1],
    [200, 2],
    [235, 1],
    [254, 1],
    [268, 2],
    [288, 1],
    [327, 16],
    [380, 4],
  ]
  const keys = groups.flatMap(([line, count]) =>
    Array.from(
      { length: count! },
      (_, index) => `src/dom/tests/canvas-image.browser.test.ts:${line}:${index}`,
    ),
  )
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    keys,
  )
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.notEqual(selected.file, nativeStage('selection-worker-ownership').file)
})

test('canvas-image source identity preserves GPU paths, pixel oracles, clocks and cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ["'pixels',", ''],
    ["adapterPolicy: 'any'", "adapterPolicy: 'hardware'"],
    ["backend === 'webgpu-coordinated' && !controlled", "backend === 'webgpu-coordinated'"],
    ['new TestClock()', 'undefined'],
    ['clock.flushFrame()', 'Promise.resolve()'],
    ['requestAnimationFrame(() => resolve())', 'setTimeout(resolve, 0)'],
    ['context.drawImage(source, 0, 0)', 'context.clearRect(0, 0, 1, 1)'],
    ['context.getImageData(0, 0, copy.width, copy.height)', 'new ImageData(1, 1)'],
    [
      "vi.spyOn(WebGpuTextPass.prototype, 'submit')",
      "vi.spyOn(WebGpuTextPass.prototype, 'encode')",
    ],
    ["vi.spyOn(device.queue, 'submit')", "vi.spyOn(device.queue, 'writeBuffer')"],
    ['expect(image).not.toHaveBeenCalled()', 'expect(image).toHaveBeenCalled()'],
    ["expect(order).toEqual(['image', 'public'])", "expect(order).toEqual(['public', 'image'])"],
    ['blink()', 'Promise.resolve()'],
    ['Promise.reject("foreign capture")', 'Promise.resolve("foreign capture")'],
    ['setTimeout(resolve, 0)', 'setTimeout(resolve, 1)'],
    ['expect(seen[0]!.snapshot).toBe(first)', 'expect(seen[0]!.snapshot).not.toBe(first)'],
    [
      'expect(f.terminal.submittedFrame!.nativeRevision).toBe(captured)',
      'expect(captured).toBeGreaterThan(0)',
    ],
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

test('canvas-image result validation rejects each omitted row, duplicate IDs and changed options', () => {
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
  assert.throws(() =>
    verifyNativeStage(stage, resultFixture('selection-worker-ownership'), receiptFixture),
  )
})

test('canvas-image appears in launcher and verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})
