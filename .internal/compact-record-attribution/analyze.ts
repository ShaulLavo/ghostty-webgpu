import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

// Boundary readers and the paired oracle extend the retained 005 fail-closed analyzer.
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
function parseRow(value: unknown) {
  const item = object(value)
  const measured = object(item.measured)
  const metrics = object(measured.metrics)
  const records = array(item.records).map(object)
  const digests = array(item.recordDigests).map(object)
  assert.equal(digests.length, 1)
  for (const digest of digests)
    for (const key of ['cell', 'glyph']) assert(/^[a-f0-9]{64}$/.test(text(digest[key])))
  const native = array(item.native).map((value) => {
    const entry = object(value)
    const totals = array(entry.totals).map(number)
    const counts = array(entry.counts).map(number)
    assert.equal(totals.length, 6)
    assert.equal(counts.length, 6)
    assert(totals.every((value) => value >= 0))
    assert(counts.every((value) => Number.isSafeInteger(value) && value >= 0))
    assert.equal(
      counts.slice(0, 5).reduce((sum, count) => sum + count, 0),
      counts[5],
    )
    return { totals, counts }
  })
  const qualification = object(item.qualification)
  const cpu = object(item.cpu)
  assert.equal(cpu.churn, false)
  assert(
    number(qualification.paintedPixels) /
      (number(qualification.width) * number(qualification.height)) >
      0.999,
  )
  assert.notEqual(item.pixelHash, qualification.pixelHash)
  assert.notEqual(item.warmPixelHash, qualification.pixelHash)
  assert.equal(measured.pendingFrames, 0)
  assert.equal(measured.steps, 64)
  assert.equal(metrics.submittedFrames, 64)
  assert.equal(metrics.acknowledgements, 64)
  assert(number(metrics.draws) > 0)
  assert.equal(records.length, 1)
  const [record] = records
  assert(record)
  const columns = number(record.columns)
  const rows = number(record.rows)
  const expected = new Map([
    ['ntcharts-heatmap', { columns: 100, rows: 30, bytes: 4146336 }],
    ['opentui-plasma', { columns: 100, rows: 30, bytes: 7306231 }],
    ['changing-dense', { columns: 200, rows: 50, bytes: 647104 }],
  ]).get(text(item.scenario))
  assert(expected)
  assert.equal(columns, expected.columns)
  assert.equal(rows, expected.rows)
  assert.equal(measured.writtenBytes, expected.bytes)
  assert.equal(record.cellBytes, columns * rows * 64)
  assert.equal(record.glyphBytes, columns * rows * 96)
  assert.equal(record.sameMemory, true)
  assert(number(record.cellByteOffset) + number(record.cellBytes) <= number(record.wasmMemoryBytes))
  assert(
    number(record.glyphByteOffset) + number(record.glyphBytes) <= number(record.wasmMemoryBytes),
  )
  const attribution = object(item.attribution)
  assert.equal(attribution.uploadBytes, metrics.uploadedBytes)
  assert.equal(attribution.buildCalls, metrics.bridgeBuilds)
  return {
    backend: text(item.backend),
    scenario: text(item.scenario),
    arm: text(item.arm),
    repetition: number(item.repetition),
    pixelHash: text(item.pixelHash),
    warmPixelHash: text(item.warmPixelHash),
    textHash: text(item.textHash),
    width: number(item.width),
    height: number(item.height),
    writtenBytes: number(measured.writtenBytes),
    metrics,
    record,
    native,
    recordDigests: array(item.recordDigests).map(object),
    cpu: object(cpu.seconds),
    callbackMs: array(measured.callbackMilliseconds)
      .map(number)
      .reduce((sum, value) => sum + value, 0),
    writeMs: array(measured.writeMilliseconds)
      .map(number)
      .reduce((sum, value) => sum + value, 0),
  }
}
type Row = ReturnType<typeof parseRow>
function checkPair(left: Row, right: Row) {
  assert.deepEqual(left.recordDigests, right.recordDigests)
  for (const key of [
    'backend',
    'scenario',
    'repetition',
    'pixelHash',
    'warmPixelHash',
    'textHash',
    'width',
    'height',
    'writtenBytes',
  ] as const)
    assert.equal(left[key], right[key], key)
  for (const key of [
    'submittedFrames',
    'bridgeBuilds',
    'acknowledgements',
    'acknowledgedRows',
    'rebuiltRows',
    'uploadedBytes',
    'instanceUploadOperations',
    'draws',
  ])
    assert.equal(left.metrics[key], right.metrics[key], key)
  for (const key of [
    'cellHash',
    'glyphHash',
    'cellBytes',
    'glyphBytes',
    'activeCells',
    'activeGlyphs',
    'rowReuses',
    'rowRebuilds',
    'stableRows',
    'rowOffset',
  ])
    assert.equal(left.record[key], right.record[key], key)
}
function components(row: Row) {
  const [probe] = row.native
  assert(probe)
  assert(number(probe.counts[0]) > 0 && number(probe.counts[3]) > 0 && number(probe.counts[4]) > 0)
  const emptyPerCall = number(probe.totals[5]) / number(probe.counts[5])
  const corrected = probe.totals
    .slice(0, 5)
    .map((value, index) => value - number(probe.counts[index]) * emptyPerCall)
  return {
    rawMs: probe.totals,
    calls: probe.counts,
    emptyPerCallMs: emptyPerCall,
    correctedMs: corrected,
    constructionMs: number(corrected[0]) + number(corrected[1]),
    recordsMs: corrected.slice(0, 4).reduce((sum, value) => sum + value, 0),
    lookupMs: corrected[4],
  }
}
export function analyze(value: unknown) {
  const data = object(value)
  const capability = object(data.capability)
  const gpu = object(capability.webgpu)
  const gl = object(capability.webgl2)
  assert.equal(gpu.positiveControl, true)
  assert.equal(object(gpu.identity).isFallbackAdapter, false)
  assert.equal(gl.positiveControl, true)
  assert.equal(gl.error, 0)
  assert(!/swiftshader|llvmpipe|lavapipe/i.test(JSON.stringify(capability)))
  const rows = array(data.results).map(parseRow)
  assert.equal(
    new Set(rows.map((row) => `${row.backend}/${row.scenario}/${row.repetition}/${row.arm}`)).size,
    rows.length,
  )
  for (const row of rows) {
    assert(['webgpu', 'webgl2'].includes(row.backend))
    assert(row.repetition === 0 || row.repetition === 1)
  }
  assert(data.delivery === undefined || data.delivery === 'prepared-u8')
  const staged = data.delivery === 'prepared-u8'
  assert.equal(rows.length, staged ? 36 : 48)
  const arms = staged
    ? ['released', 'timed', 'positive']
    : ['released', 'extracted', 'timed', 'positive']
  assert(rows.every((row) => arms.includes(row.arm)))
  const comparisons = rows
    .filter((row) => row.arm === 'released')
    .map((released) => compareGroup(released, rows, staged))
  assert.equal(comparisons.length, 12)
  return {
    source: data.source,
    delivery: staged ? 'prepared-u8' : 'controller-json-inside-cpu-window',
    comparisons,
    pairedGroups: 12,
    performanceQualified: false,
    reopeningCondition: 'not established',
    reason:
      'Research-only PC component attribution. No matched external worker/painting experiment or layout candidate. Original acceptance matrix unchanged.',
  }
}
function compareGroup(released: Row, rows: Row[], staged: boolean) {
  const find = (arm: string) => {
    const matches = rows.filter(
      (row) =>
        row.arm === arm &&
        row.backend === released.backend &&
        row.scenario === released.scenario &&
        row.repetition === released.repetition,
    )
    assert.equal(matches.length, 1)
    const [entry] = matches
    assert(entry)
    checkPair(released, entry)
    return entry
  }
  const extracted = staged ? null : find('extracted')
  const timed = find('timed')
  const positive = find('positive')
  assert.equal(released.native.length, 0)
  if (extracted) assert.equal(extracted.native.length, 0)
  assert.equal(timed.native.length, 1)
  assert.equal(positive.native.length, 1)
  const component = components(timed)
  const control = components(positive)
  assert.deepEqual(component.calls, control.calls)
  assert(
    control.constructionMs > component.constructionMs * 3 && control.constructionMs > 1,
    '32-repeat actual construction must amplify the measured construction channel',
  )
  return {
    backend: released.backend,
    scenario: released.scenario,
    repetition: released.repetition,
    bytes: released.writtenBytes,
    uploadedBytes: released.metrics.uploadedBytes,
    component,
    positive: control,
    bridgeMs: {
      released: released.metrics.bridgeMilliseconds,
      extracted: extracted?.metrics.bridgeMilliseconds ?? null,
      timed: timed.metrics.bridgeMilliseconds,
      positive: positive.metrics.bridgeMilliseconds,
    },
    cpu: {
      released: released.cpu,
      extracted: extracted?.cpu ?? null,
      timed: timed.cpu,
      positive: positive.cpu,
    },
    callbacksMs: {
      released: released.callbackMs,
      extracted: extracted?.callbackMs ?? null,
      timed: timed.callbackMs,
      positive: positive.callbackMs,
    },
    pixelHash: released.pixelHash,
    record: released.record,
  }
}
if (import.meta.main) {
  const [input, output] = process.argv.slice(2)
  assert(input && output)
  const raw: unknown = JSON.parse(await readFile(input, 'utf8'))
  const result = analyze(raw)
  const data = object(raw)
  const originals = array(data.results)
  const change = (key: string, next: unknown) => ({
    ...data,
    results: originals.map((value, index) =>
      index === 0 ? { ...object(value), [key]: next } : value,
    ),
  })
  for (const invalid of [
    change('pixelHash', 'wrong'),
    change('textHash', 'wrong'),
    change('measured', { ...object(object(originals[0]).measured), writtenBytes: 0 }),
    change('records', []),
    { ...data, capability: {} },
    change('measured', {
      ...object(object(originals[0]).measured),
      metrics: { ...object(object(object(originals[0]).measured).metrics), acknowledgements: 0 },
    }),
    change('recordDigests', []),
  ])
    assert.throws(() => analyze(invalid))
  await writeFile(output, JSON.stringify({ ...result, negativeControls: 7 }, null, 2) + '\n')
  console.log('Twelve output/counter groups and seven fail-closed controls passed.')
}
