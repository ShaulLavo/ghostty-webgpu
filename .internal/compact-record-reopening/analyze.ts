import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value))
  return value
}
function number(value: unknown): number {
  assert(typeof value === 'number' && Number.isFinite(value))
  return value
}
function text(value: unknown): string {
  assert(typeof value === 'string')
  return value
}
function row(value: unknown) {
  const item = object(value)
  const measured = object(item.measured)
  const metrics = object(measured.metrics)
  return {
    backend: text(item.backend),
    scenario: text(item.scenario),
    arm: text(item.arm),
    textHash: text(item.textHash),
    pixelHash: text(item.pixelHash),
    steps: number(measured.steps),
    writtenBytes: number(measured.writtenBytes),
    submittedFrames: number(metrics.submittedFrames),
    builds: number(metrics.bridgeBuilds),
    acknowledgements: number(metrics.acknowledgements),
    acknowledgedRows: number(metrics.acknowledgedRows),
    rebuiltRows: number(metrics.rebuiltRows),
    bytes: number(metrics.uploadedBytes),
    operations: number(metrics.instanceUploadOperations),
    bridgeMs: number(metrics.bridgeMilliseconds),
    rowPlanMs: number(metrics.rowPlanMilliseconds),
    writeMs: array(measured.writeMilliseconds).reduce<number>(
      (total, value) => total + number(value),
      0,
    ),
    callbackMs: array(measured.callbackMilliseconds).reduce<number>(
      (total, value) => total + number(value),
      0,
    ),
    width: number(item.width),
    height: number(item.height),
    attribution: item.attribution === undefined ? null : object(item.attribution),
    records: item.records === undefined ? [] : array(item.records).map(object),
    cpu: object(item.cpu),
  }
}
type Row = ReturnType<typeof row>
function checkPair(left: Row, right: Row): void {
  assert.equal(left.arm, 'plain')
  assert.equal(right.arm, 'instrumented')
  for (const key of [
    'backend',
    'scenario',
    'textHash',
    'pixelHash',
    'steps',
    'writtenBytes',
    'submittedFrames',
    'acknowledgements',
    'acknowledgedRows',
    'rebuiltRows',
    'bytes',
    'operations',
    'width',
    'height',
  ] as const)
    assert.equal(left[key], right[key], key)
  assert.equal(left.steps, 32)
  assert.equal(left.submittedFrames, 32)
  assert.equal(left.acknowledgements, 32)
  assert.equal(right.records.length, 1)
  const [records] = right.records
  assert(records)
  assert.equal(records.cellBytes, 200 * 50 * 64)
  assert.equal(records.glyphBytes, 200 * 50 * 96)
  assert.equal(records.sameMemory, true)
  assert(
    number(records.cellByteOffset) + number(records.cellBytes) <= number(records.wasmMemoryBytes),
  )
  assert(
    number(records.glyphByteOffset) + number(records.glyphBytes) <= number(records.wasmMemoryBytes),
  )
  assert(right.attribution)
  assert.equal(right.attribution.uploadBytes, right.bytes)
  assert.equal(right.attribution.buildCalls, right.builds)
}
const input = process.argv[2]
const destination = process.argv[3]
assert(input && destination)
const data = object(JSON.parse(await readFile(input, 'utf8')))
const capability = object(data.capability)
const gpu = object(capability.webgpu)
const gl = object(capability.webgl2)
assert.equal(gpu.positiveControl, true)
assert.equal(gl.positiveControl, true)
assert.equal(object(gpu.identity).isFallbackAdapter, false)
assert.equal(gl.error, 0)
const rows = array(data.results).map(row)
assert.equal(rows.length, 12)
const pairs = rows
  .filter((item) => item.arm === 'plain')
  .map((left) => {
    const right = rows.find(
      (item) =>
        item.arm === 'instrumented' &&
        item.backend === left.backend &&
        item.scenario === left.scenario,
    )
    assert(right)
    checkPair(left, right)
    return { plain: left, instrumented: right }
  })
assert.equal(pairs.length, 6)
const [pair] = pairs
assert(pair)
for (const corrupt of [
  { ...pair.instrumented, pixelHash: 'wrong' },
  { ...pair.instrumented, textHash: 'wrong' },
  { ...pair.instrumented, submittedFrames: 0 },
  { ...pair.instrumented, writtenBytes: 0 },
  { ...pair.instrumented, records: [{ ...pair.instrumented.records[0], glyphBytes: 0 }] },
])
  assert.throws(() => checkPair(pair.plain, corrupt))
await writeFile(
  destination,
  JSON.stringify(
    {
      source: data.source,
      pairs,
      pairedControls: 6,
      negativeControls: 5,
      performanceQualified: false,
      reopeningCondition: 'not established',
      reason:
        'No ownership-matched compact-record benefit or record-packing-only CPU attribution. Current own controls preserve output and counters but compare no layout candidate.',
    },
    null,
    2,
  ) + '\n',
)
console.log('Six equal-output pairs and five fail-closed negative controls passed.')
