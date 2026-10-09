import { PNG } from 'pngjs'
import { compactEvidence, comparisonLatencyEndpoint } from './comparison-compact.mjs'
import { ink } from './comparison-pixels.mjs'
import { ComparisonTracing } from '../bench/comparison-tracing.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import {
  droppedFrames,
  markdown,
  order,
  pairedRatios,
  quantile,
  summaries,
} from './comparison-report.mjs'
import { cpuSample, verifyHash, withDeadline } from './comparison-guards.mjs'
import { createMacHostGate, macCpuAccounting } from './comparison-mac.mjs'
import './comparison-trace.test.mjs'
import './comparison-attribution.test.mjs'
import './comparison-options.test.mjs'
import './comparison-gpu.test.mjs'
import './comparison-latency.test.mjs'
import {
  expectedScreen,
  inputChunks,
  pacedBurst,
  parseChunks,
  qualifyScreen,
  synchronousWrite,
} from '../bench/comparison-protocol.ts'

test('native resolver provenance excludes package metadata and matches its build source', () => {
  const buildBytes = readFileSync(new URL('./config-resolver-native/build.zig', import.meta.url))
  const inputBytes = readFileSync(
    new URL('./config-resolver-native/native-inputs.json', import.meta.url),
  )
  const inputs = JSON.parse(inputBytes)
  const nativeRoot = new URL('../native/config-resolver/', import.meta.url)
  const markerName = existsSync(new URL('bootstrap.json', nativeRoot))
    ? 'bootstrap.json'
    : 'manifest.json'
  const marker = JSON.parse(readFileSync(new URL(markerName, nativeRoot)))
  assert.equal(
    inputs.ownedFiles.some((file) => file.path === 'package.json'),
    false,
  )
  assert.deepEqual(
    inputs.ownedFiles.find((file) => file.path === 'scripts/config-resolver-native/build.zig'),
    {
      path: 'scripts/config-resolver-native/build.zig',
      mode: '100644',
      bytes: buildBytes.length,
      sha256: createHash('sha256').update(buildBytes).digest('hex'),
    },
  )
  assert.equal(marker.nativeInputsTreeSha256, createHash('sha256').update(inputBytes).digest('hex'))
})

test('median averages the middle pair and p95 uses nearest rank', () => {
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5)
  assert.equal(
    quantile(
      Array.from({ length: 20 }, (_, index) => index + 1),
      0.95,
    ),
    19,
  )
  assert.throws(() => quantile([], 0.5))
  assert.throws(() => quantile([NaN], 0.5))
})

test('library order reverses and rotates without dropping variants', () => {
  const variants = ['native', 'webgl', 'dom', 'legacy']
  assert.deepEqual(order(variants, 0), variants)
  assert.deepEqual(order(variants, 1), ['legacy', 'dom', 'webgl', 'native'])
  assert.deepEqual(order(variants, 2), ['webgl', 'dom', 'legacy', 'native'])
})

test('dropped-frame inference respects the measured display period', () => {
  assert.equal(droppedFrames([8.3, 16.6, 24.9], 8.3), 3)
  assert.equal(droppedFrames([16.6, 33.2, 49.8], 16.6), 3)
  assert.throws(() => droppedFrames([1], 0))
})

test('results take medians across repetitions and preserve negative memory noise', () => {
  const runs = [1, 3, 2].map((value) => ({
    variant: 'ghostty-webgpu',
    path: 'bytes',
    count: 1,
    parse: {
      ascii: { bytes: value * 1_000_000, milliseconds: 1000, validation: { qualified: true } },
    },
    latency: { write: [value, value + 1] },
    memory: {
      empty: { heap: { usedSize: 20, backingStorageSize: 0 } },
      initial: { heap: { usedSize: 10, backingStorageSize: 0 }, wasmBytes: 65536 },
      history: { heap: { usedSize: 30, backingStorageSize: 0 }, wasmBytes: 65536 },
    },
  }))
  runs.push({
    variant: 'ghostty-webgpu',
    path: 'bytes',
    count: 1,
    error: 'failed',
    parse: { ascii: { bytes: 999999999, milliseconds: 1 } },
  })
  const rows = summaries({ runs })
  assert.equal(rows.find(({ metric }) => metric === 'parse/ascii').median, 2)
  assert.equal(rows.find(({ metric }) => metric === 'write/p50').median, 2.5)
  assert.equal(rows.find(({ metric }) => metric === 'memory/terminal').median, -10 / 1048576)
  assert.equal(rows.find(({ metric }) => metric === 'parse/ascii').repetitions, 3)
})

test('paired frame-builder summaries keep JS and Zig treatments separate', () => {
  const runs = ['js', 'zig'].map((frameBuilder, index) => ({
    variant: 'ghostty-webgpu',
    frameBuilder,
    path: 'bytes',
    count: 17,
    latency: { write: [index + 1] },
  }))
  const rows = summaries({ runs })
  assert.equal(rows.find((row) => row.variant === 'ghostty-webgpu-js').median, 1)
  assert.equal(rows.find((row) => row.variant === 'ghostty-webgpu-zig').median, 2)
})

test('builders created before recording acquire their own measured boundary', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?trace' } })
  try {
    const tracing = new ComparisonTracing()
    const factory = { create: () => ({ build: () => 42 }) }
    tracing.wrap(
      factory,
      'create',
      0,
      'js',
      (builder) => {
        tracing.wrap(builder, 'build', 0, 'instances')
      },
      true,
    )
    const builder = factory.create()
    tracing.begin()
    assert.equal(builder.build(), 42)
    const result = tracing.end()
    assert.deepEqual(
      result.spans.map((span) => [span.operation, span.category]),
      [['build', 'instances']],
    )
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original)
    else delete globalThis.location
  }
})

test('paired frame-builder report exposes both native absolute measurements', () => {
  const artifact = pairedArtifact()
  const baselineRows = pairedRatios(artifact)
  assert(markdown(artifact).includes('GPU frame builders: unlabeled.'))
  artifact.runs = artifact.runs.flatMap((run) =>
    run.variant === 'ghostty-webgpu'
      ? ['js', 'zig'].map((frameBuilder) => ({ ...run, frameBuilder }))
      : [run],
  )
  const report = markdown(artifact)
  assert(report.includes('| Measure | ghostty-webgpu-js | ghostty-webgpu-zig | xterm-webgl |'))
  assert(report.includes('GPU frame builders: js, zig.'))
  const nativeRows = pairedRatios(artifact)
  assert.equal(nativeRows.length, baselineRows.length * 2)
  for (const builder of ['js', 'zig'])
    assert.deepEqual(
      nativeRows
        .filter((row) => row.frameBuilder === builder)
        .map(({ frameBuilder: _, ...row }) => row),
      baselineRows,
    )
})

test('software smoke never produces a results document', () => {
  assert.throws(() => markdown({ smoke: true, hardware: false }))
})

test('qualified parser measurements survive a later rendering failure', () => {
  const run = {
    variant: 'ghostty-web',
    path: 'bytes',
    count: 1,
    error: 'history failed',
    parseQualified: true,
    parse: { ascii: { bytes: 1_000_000, milliseconds: 100, validation: { qualified: true } } },
    latency: { write: [1, 2] },
  }
  const rows = summaries({ runs: [run] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].metric, 'parse/ascii')
  assert.equal(rows[0].median, 10)
})

test('output memory keeps retained storage, WASM capacity, and RSS separate', () => {
  const snapshot = (usedSize, backingStorageSize, wasmBytes, rssBytes) => ({
    heap: { usedSize, backingStorageSize },
    wasmBytes,
    rssBytes,
  })
  const rows = summaries({
    runs: [
      {
        variant: 'ghostty-webgpu',
        path: 'bytes',
        count: 8,
        memory: {
          empty: snapshot(1_048_576, 0, 0, 10_485_760),
          initial: snapshot(2_097_152, 0, 1_048_576, 12_582_912),
          history: snapshot(3_145_728, 0, 2_097_152, 14_680_064),
        },
        output: {
          cpu: { percentOfOneCore: 0 },
          memory: snapshot(4_194_304, 1_048_576, 2_097_152, 16_777_216),
        },
      },
    ],
  })
  assert.equal(rows.find(({ metric }) => metric === 'memory/output/terminal').median, 0.5)
  assert.equal(rows.find(({ metric }) => metric === 'memory/output/wasm').median, 2)
  assert.equal(rows.find(({ metric }) => metric === 'memory/output/rss-delta').median, 6)
})

for (const path of ['bytes', 'string']) {
  test(`${path} memory reports exclude retained fixture storage at every terminal count`, () => {
    for (const count of [1, 8, 17]) {
      const fixtureBytes = path === 'bytes' ? 5 * 1048576 : 8 * 1048576
      const snapshot = (multiplier, preparedBytes) => ({
        heap: {
          usedSize: preparedBytes + count * multiplier * 131072,
          backingStorageSize: preparedBytes + count * multiplier * 65536,
        },
        wasmBytes: multiplier ? 65536 : 0,
        rssBytes: preparedBytes * 3 + count * multiplier * 1048576,
      })
      const report = (preparedBytes, terminalMultiplier) =>
        summaries({
          runs: [
            {
              variant: 'ghostty-dom',
              path,
              count,
              memory: {
                empty: snapshot(0, preparedBytes),
                initial: snapshot(terminalMultiplier, preparedBytes),
                history: snapshot(terminalMultiplier * 2, preparedBytes),
              },
              output: {
                cpu: { percentOfOneCore: 0 },
                memory: snapshot(terminalMultiplier * 3, preparedBytes),
              },
            },
          ],
        }).filter(({ metric }) => metric.startsWith('memory/'))
      assert.deepEqual(report(fixtureBytes, 1), report(0, 1))
      assert(report(fixtureBytes, 0).every(({ median }) => median === 0))
    }
  })
}

test('thin antialiased glyphs qualify without counting neutral or transparent ink', () => {
  const png = new PNG({ width: 5, height: 1 })
  png.data.set([0, 95, 0, 255, 100, 0, 0, 255, 255, 255, 255, 255, 80, 80, 80, 255, 0, 255, 0, 0])
  const colors = ink(PNG.sync.write(png).toString('base64'))
  assert.equal(colors.green, 1)
  assert.equal(colors.red, 1)
  assert.equal(colors.greenPeak, 95)
  assert.equal(colors.redPeak, 100)
})

test('string chunk construction never writes empty decoder output and preserves final text', () => {
  const text = 'ASCII 日本語 é 👩‍💻 👨‍👩‍👧‍👦 🧪'
  const bytes = new TextEncoder().encode(text)
  for (const size of [1, 3, 4096]) {
    const chunks = inputChunks(bytes, 'string', size)
    assert(chunks.every((chunk) => chunk.length > 0))
    assert.equal(chunks.join(''), text)
  }
  assert.deepEqual(inputChunks(new Uint8Array(), 'string', 1), [])
  assert.deepEqual(inputChunks(new Uint8Array([0xf0, 0x9f]), 'string', 1), ['�'])
  assert.throws(() => inputChunks(bytes, 'string', 0), /positive/)
})

test('byte chunks preserve every UTF-8 byte including one-byte splits', () => {
  const bytes = new TextEncoder().encode('👩‍💻')
  assert.deepEqual(
    inputChunks(bytes, 'bytes', 1).flatMap((chunk) => [...chunk]),
    [...bytes],
  )
})

test('legacy adapter calls synchronous public write without a presentation callback', async () => {
  let args
  let parsed = false
  const write = synchronousWrite((...input) => {
    args = input
    parsed = true
  })
  const result = write('payload')
  assert.equal(parsed, true)
  assert.deepEqual(args, ['payload'])
  await result
})

test('all burst drivers get one shared pacing frame per write', async () => {
  const calls = []
  let time = 0
  const intervals = await pacedBurst(
    async () => {
      calls.push('write')
    },
    async () => {
      calls.push('frame')
      return (time += 16)
    },
    3,
  )
  assert.deepEqual(calls, ['frame', 'write', 'frame', 'write', 'frame', 'write', 'frame'])
  assert.deepEqual(intervals, [16, 16, 16])
})

test('isolated parser requires synchronous completion and keeps failed chunk attribution', () => {
  const writes = []
  parseChunks(
    (chunk) => {
      writes.push(chunk)
    },
    ['one', 'two'],
  )
  assert.deepEqual(writes, ['one', 'two'])
  assert.throws(() => parseChunks(async () => {}, ['one']), /chunk 0.*async work/)
  assert.throws(
    () =>
      parseChunks(() => {
        throw new Error('trap')
      }, ['one']),
    /chunk 0.*trap/,
  )
})

test('independent parser oracle checks text, cursor, truecolor, indexed color, and styles', () => {
  const expected = expectedScreen('sgr', '', 20, 40, 12)
  const actual = {
    lines: [...expected.lines],
    cursor: { ...expected.cursor },
    cells: Array.from({ length: 12 }, () =>
      Array.from({ length: 40 }, () => ({
        text: '',
        bold: false,
        underline: false,
        rgb: [200, 200, 200],
      })),
    ),
  }
  for (const probe of expected.probes) {
    const cell = actual.cells[probe.y][probe.x]
    if (probe.bold !== undefined) cell.bold = probe.bold
    if (probe.underline !== undefined) cell.underline = probe.underline
    if (probe.rgb) cell.rgb = [...probe.rgb]
    if (probe.hue === 'red') cell.rgb = [200, 0, 0]
  }
  assert.equal(qualifyScreen(actual, expected).qualified, true)
  for (const change of [
    (screen) => {
      screen.lines[0] = 'wrong'
    },
    (screen) => {
      screen.cursor.x = 1
    },
    (screen) => {
      screen.cells[0][4].rgb[0] = 51
    },
    (screen) => {
      screen.cells[0][14].bold = false
    },
    (screen) => {
      screen.cells[0][14].underline = false
    },
    (screen) => {
      screen.cells[0][0].rgb = [0, 200, 0]
    },
  ]) {
    const corrupt = structuredClone(actual)
    change(corrupt)
    assert.throws(() => qualifyScreen(corrupt, expected))
  }
  const unicode = expectedScreen('unicode', 'é 👩‍💻\r\n', 1, 40, 12)
  const screen = { ...actual, lines: [...unicode.lines], cursor: unicode.cursor }
  screen.lines[0] = 'é 👩‍💻   '
  assert.equal(qualifyScreen(screen, unicode).qualified, true)
  screen.lines[0] = 'é 👩💻'
  assert.throws(() => qualifyScreen(screen, unicode), /text mismatch/)
  assert.deepEqual(expectedScreen('ascii', 'hello\r\n', 1, 40, 3).lines, ['hello', '', ''])
  assert.deepEqual(expectedScreen('logs', 'abcdef\r\n', 1, 3, 4).lines, ['abc', 'def', '', ''])
  assert.deepEqual(expectedScreen('cursor', '', 1, 40, 12).cursor, { x: 0, y: 0 })
})

test('only individually validated parser samples enter summaries', () => {
  const run = {
    variant: 'xterm-dom',
    path: 'bytes',
    count: 1,
    parseQualified: false,
    parse: {
      ascii: { bytes: 1000000, milliseconds: 100, validation: { qualified: true } },
      unicode: { bytes: 1000000, milliseconds: 1 },
    },
  }
  assert.deepEqual(
    summaries({ runs: [run] }).map(({ metric }) => metric),
    ['parse/ascii'],
  )
})

test('CPU sampling rejects both newly born and exited processes', () => {
  const prior = [{ id: 1, type: 'renderer', cpuTime: 1 }]
  assert.equal(
    cpuSample(prior, [{ id: 1, type: 'renderer', cpuTime: 1.5 }], 1000).percentOfOneCore,
    50,
  )
  assert.throws(() => cpuSample(prior, [], 1000), /process set changed/)
  assert.throws(
    () => cpuSample(prior, [...prior, { id: 2, type: 'gpu', cpuTime: 0 }], 1000),
    /process set changed/,
  )
})

test('CPU sampling rejects counter regression with an unchanged process set', () => {
  const before = [
    { id: 1, type: 'renderer', cpuTime: 100 },
    { id: 2, type: 'GPU', cpuTime: 100 },
  ]
  const flat = [
    { id: 1, type: 'renderer', cpuTime: 102 },
    { id: 2, type: 'GPU', cpuTime: 100 },
  ]
  const valid = cpuSample(before, flat, 10000)
  assert.deepEqual(valid.secondsByType, { renderer: 2, GPU: 0 })
  assert.equal(valid.percentOfOneCore, 20)
  assert.equal(valid.before, before)
  assert.equal(valid.after, flat)
  assert.throws(
    () => cpuSample(before, [flat[0], { id: 2, type: 'GPU', cpuTime: 99 }], 10000),
    /CPU counter delta invalid for process 2: before=100 after=99/,
  )
})

test('CPU sampling rejects nonfinite counter deltas', () => {
  const before = [{ id: 1, type: 'renderer', cpuTime: 100 }]
  for (const cpuTime of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => cpuSample(before, [{ id: 1, type: 'renderer', cpuTime }], 10000),
      /CPU counter delta invalid for process 1/,
    )
  }
})

test('asset verification rejects modified bytes before serving', () => {
  const bytes = Buffer.from('asset')
  const hash = createHash('sha256').update(bytes).digest('hex')
  verifyHash(bytes, hash, 'asset')
  assert.throws(() => verifyHash(Buffer.from('modified'), hash, 'asset'), /hash mismatch: asset/)
})

test('case deadline closes stalled contexts and clears settled timers', async () => {
  let closed = false
  await assert.rejects(
    withDeadline(
      () => new Promise(() => {}),
      5,
      () => {
        closed = true
      },
    ),
    /deadline exceeded/,
  )
  assert.equal(closed, true)
  assert.equal(
    await withDeadline(
      async () => 42,
      1000,
      () => assert.fail('settled operation expired'),
    ),
    42,
  )
})

test('portable reports link beside their artifact and checked-in reports use destination-relative links', () => {
  const artifact = {
    hardware: true,
    repetitions: 3,
    runs: [],
    environment: {},
    manifest: { versions: {}, settings: { counts: [] }, variants: [] },
  }
  const review = { coverage: 'Reviewed', links: [{ label: 'screen', path: 'screen.png' }] }
  const portable = markdown(artifact, review)
  assert(portable.includes('[comparison.json](comparison.json)'))
  assert(portable.includes('[screen](screen.png)'))
  assert(!portable.includes('](benchmarks/mac-m1/comparison.json)'))
  const published = markdown(artifact, review, 'benchmarks/mac-m1')
  assert(published.includes('[comparison.json](benchmarks/mac-m1/comparison.json)'))
  assert(published.includes('[screen](benchmarks/mac-m1/screen.png)'))
})

function pairedArtifact() {
  const runs = [0, 1, 2].flatMap((repetition) =>
    ['ghostty-webgpu', 'xterm-webgl'].map((variant) => {
      const value =
        variant === 'ghostty-webgpu' ? [1, 10, 100][repetition] : [2, 100, 101][repetition]
      const cpu = {
        percentOfOneCore: value,
        secondsByType: { renderer: value },
        milliseconds: 100_000,
        tickSeconds: 0.01,
      }
      return {
        variant,
        repetition,
        pairId: `session/${repetition}`,
        sessionId: 'browser-session',
        path: 'bytes',
        count: 1,
        latency: { input: [value, value], write: [value, value] },
        idle: { cpu },
        output: { cpu },
      }
    }),
  )
  return {
    runs,
    variants: ['ghostty-webgpu', 'xterm-webgl'],
    paths: ['bytes'],
    counts: [1],
    repetitions: 3,
    hardware: true,
    environment: {},
    manifest: {
      versions: {},
      settings: { counts: [1] },
      variants: [{ id: 'ghostty-webgpu' }, { id: 'xterm-webgl' }],
    },
  }
}

test('paired ratios use per-repetition divisions, retain absolutes, and accept equality', () => {
  const artifact = pairedArtifact()
  const rows = pairedRatios(artifact)
  assert.equal(rows.length, 7)
  assert.deepEqual(
    rows.map(({ metric }) => metric),
    [
      'idle/cpu/renderer',
      'idle/cpu/total',
      'output/cpu/renderer',
      'output/cpu/total',
      'input/p50',
      'input/p95',
      'write/p50',
    ],
  )
  for (const row of rows) {
    assert.equal(row.status, 'pass')
    assert.equal(row.target, 1)
    assert.equal(row.median, 0.5)
    assert.deepEqual(
      row.pairs.map(({ ratio }) => ratio),
      [0.5, 0.1, 100 / 101],
    )
    assert.equal(row.pairs[1].native, 10)
    assert.equal(row.pairs[1].counterpart, 100)
  }
  for (const run of artifact.runs) run.latency.write = [5]
  assert.equal(pairedRatios(artifact).find(({ metric }) => metric === 'write/p50').status, 'pass')
})

test('pairing rejects mismatched IDs, repetition, path, count, duplicate and missing partners', () => {
  for (const change of [
    (run) => {
      run.pairId = 'different-session'
    },
    (run) => {
      delete run.pairId
    },
    (run) => {
      run.repetition = 8
    },
    (run) => {
      run.path = 'string'
    },
    (run) => {
      run.count = 8
    },
  ]) {
    const artifact = pairedArtifact()
    change(artifact.runs[1])
    const row = pairedRatios(artifact).find(
      ({ metric, path, count }) => metric === 'write/p50' && path === 'bytes' && count === 1,
    )
    assert.equal(row.repetitions, 2)
    assert.equal(row.status, 'incomplete')
  }
  for (const duplicate of [true, false]) {
    const artifact = pairedArtifact()
    if (duplicate) artifact.runs.push(structuredClone(artifact.runs[1]))
    if (!duplicate) artifact.runs.splice(1, 1)
    assert(
      pairedRatios(artifact).every((row) => row.status === 'incomplete' && row.repetitions === 2),
    )
  }
})

test('GPU-idle rejection excludes the whole run and leaves passing pairs incomplete', () => {
  const artifact = pairedArtifact()
  const run = artifact.runs[0]
  run.gpuIdle = { qualified: false }
  run.parse = { ascii: { bytes: 1_000_000, milliseconds: 10, validation: { qualified: true } } }
  assert.deepEqual(summaries({ runs: [run] }), [])
  assert(
    pairedRatios(artifact).every((row) => row.status === 'incomplete' && row.repetitions === 2),
  )
  run.gpuIdle.qualified = true
  assert(pairedRatios(artifact).every((row) => row.status === 'pass'))
})

test('missing CPU attribution and missing latency affect only their own metric', () => {
  const artifact = pairedArtifact()
  delete artifact.runs[0].idle.cpu.secondsByType
  delete artifact.runs[0].latency.input
  const rows = pairedRatios(artifact)
  assert.equal(rows.find(({ metric }) => metric === 'idle/cpu/renderer').status, 'incomplete')
  assert.equal(rows.find(({ metric }) => metric === 'input/p50').status, 'incomplete')
  assert.equal(rows.find(({ metric }) => metric === 'input/p95').status, 'incomplete')
  assert.equal(rows.find(({ metric }) => metric === 'idle/cpu/total').status, 'unresolved')
  assert.equal(rows.find(({ metric }) => metric === 'write/p50').status, 'pass')
})

test('zero baseline is a tie only at zero and positive work fails against zero', () => {
  const artifact = pairedArtifact()
  for (const run of artifact.runs) run.latency.write = [0]
  let row = pairedRatios(artifact).find(({ metric }) => metric === 'write/p50')
  assert.equal(row.median, null)
  assert.equal(row.status, 'unresolved')
  for (const run of artifact.runs.filter(({ variant }) => variant === 'ghostty-webgpu'))
    run.latency.write = [1]
  row = pairedRatios(artifact).find(({ metric }) => metric === 'write/p50')
  assert.equal(row.median, null)
  assert.match(row.medianReason, /unbounded/)
  assert.equal(row.status, 'fail')
  artifact.runs[0].error = 'failed'
  assert(pairedRatios(artifact).every((entry) => entry.status === 'incomplete'))
})

test('paired report exposes each condition status, median and individual ratio', () => {
  const artifact = pairedArtifact()
  artifact.runs[0].gpuIdle = { qualified: false }
  const report = markdown(artifact)
  assert(report.includes('## Paired pass rule'))
  assert(
    report.includes(
      '| 1 | bytes | ghostty-webgpu ↔ xterm-webgl | write/p50 | 0.55 | ≤ 1 | 2/3 | incomplete |',
    ),
  )
  assert(report.includes('| session/1 | 2 | 10.00 ms | 100.00 ms | 0.10 |'))
})

test('selected configuration retains wholly missing conditions as incomplete', () => {
  const artifact = pairedArtifact()
  artifact.variants = ['ghostty-webgpu', 'xterm-webgl']
  artifact.paths = ['bytes', 'string']
  artifact.counts = [1, 8]
  const rows = pairedRatios(artifact)
  assert.equal(rows.length, 28)
  assert(
    rows
      .filter(({ path, count }) => path === 'string' || count === 8)
      .every(
        ({ status, repetitions, median }) =>
          status === 'incomplete' && repetitions === 0 && median === null,
      ),
  )
  artifact.runs = []
  assert.equal(pairedRatios(artifact).length, 28)
  assert(pairedRatios(artifact).every(({ status }) => status === 'incomplete'))
})

test('artifacts without explicit selected configuration skip paired evaluation', () => {
  for (const field of ['variants', 'paths', 'counts']) {
    const artifact = pairedArtifact()
    delete artifact[field]
    assert.deepEqual(pairedRatios(artifact), [])
    assert(
      markdown(artifact).includes(
        'This artifact predates the selected variants, paths, or counts fields. Paired evaluation is skipped.',
      ),
    )
  }
})

test('matching pair IDs in distinct browser sessions cannot become a performance pair', () => {
  const artifact = pairedArtifact()
  artifact.runs.find((run) => run.variant === 'xterm-webgl').sessionId = 'another-browser'
  assert(
    pairedRatios(artifact).every((row) => row.status === 'incomplete' && row.repetitions === 2),
  )
})

test('CPU resolution rejects low ticks, tick ties, and zero/zero without wall-time verdicts', () => {
  for (const [nativeTicks, xtermTicks] of [
    [6, 6],
    [6, 7],
    [0, 0],
    [2, 0],
    [100, 101],
  ]) {
    const artifact = pairedArtifact()
    for (const run of artifact.runs) {
      const ticks = run.variant === 'ghostty-webgpu' ? nativeTicks : xtermTicks
      run.output.cpu = {
        tickSeconds: 0.01,
        milliseconds: run.variant === 'ghostty-webgpu' ? 1078 : 1062,
        secondsByType: { renderer: ticks * 0.01 },
        percentOfOneCore: ticks,
      }
    }
    const rows = pairedRatios(artifact).filter(({ metric }) => metric.startsWith('output/'))
    assert(rows.every(({ status }) => status === 'unresolved'))
    assert(rows.every(({ pairs }) => pairs.every(({ status }) => status === 'unresolved')))
    assert(!JSON.stringify(rows).includes('Infinity'))
  }
})

test('one unresolved CPU pair prevents a passing median from claiming resolution', () => {
  const artifact = pairedArtifact()
  artifact.runs[0].output.cpu.secondsByType.renderer = 0.06
  assert.equal(
    pairedRatios(artifact).find(({ metric }) => metric === 'output/cpu/renderer').status,
    'unresolved',
  )
})

test('skipped GPU qualification remains explicit in pairs rows and markdown', () => {
  const artifact = pairedArtifact()
  artifact.runs[0].gpuIdle = { qualified: true, skipped: 'nvidia-smi unavailable' }
  const rows = pairedRatios(artifact)
  assert(rows.every(({ gpuSkipped }) => gpuSkipped.includes('nvidia-smi unavailable')))
  assert.match(markdown(artifact), /pass \(GPU unqualified: nvidia-smi unavailable\)/)
})

test('four adjacent two-renderer pairs balance leading variants', () => {
  const variants = ['ghostty-webgpu', 'xterm-webgl']
  const leaders = [0, 1, 2, 3].map((repetition) => order(variants, repetition)[0])
  assert.equal(leaders.filter((variant) => variant === variants[0]).length, 2)
})

test('portable compaction preserves between-repetition qualifications and bounded ratio types', async () => {
  const artifact = pairedArtifact()
  artifact.outputFixture = 'rolling-logs'
  artifact.manifest.runtime = { mode: 'git-ref', commit: 'baseline', sourceSha256: 'runtime-hash' }
  artifact.manifest.benchmark = { commit: 'driver', sourceSha256: 'benchmark-hash' }
  const input = { name: 'rolling-logs', sha256: 'corpus-hash', stream: { sha256: 'cycle-hash' } }
  artifact.manifest.fixtures = [input]
  for (const run of artifact.runs)
    Object.assign(run.output, {
      fixture: input.name,
      input,
      bytes: 4096,
      chunkCount: 257,
      reset: 'corpus-start',
      completedCycles: 4,
      nextChunk: 172,
    })
  artifact.environment.gpu = { gpu: { devices: [], featureStatus: {} } }
  artifact.qualifications = [
    {
      kind: 'between-repetitions-gpu',
      repetition: 0,
      samples: [{ processes: [] }],
      qualified: true,
    },
  ]
  for (const run of artifact.runs) {
    run.info = { adapter: {} }
    run.gpuWindows = []
    run.output.frameMetrics = [{ terminal: 0, delta: { zigFrames: 1192 } }]
    run.latency.write = run.variant === 'ghostty-webgpu' ? [1] : [0]
  }
  const compact = await compactEvidence(artifact)
  assert.deepEqual(compact.qualifications, artifact.qualifications)
  assert.equal(compact.outputFixture, input.name)
  assert.deepEqual(compact.manifest.runtime, artifact.manifest.runtime)
  assert.deepEqual(compact.manifest.benchmark, artifact.manifest.benchmark)
  assert.deepEqual(compact.manifest.fixtures, [input])
  for (const run of compact.runs) {
    assert.equal(run.output.fixture, input.name)
    assert.deepEqual(run.output.input, input)
    assert.equal(run.output.bytes, 4096)
    assert.equal(run.output.nextChunk, 172)
    assert.deepEqual(run.output.frameMetrics[0].delta, { zigFrames: 1192 })
  }
  assert.deepEqual(pairedRatios(compact), compact.pairedRatios)
  const row = compact.pairedRatios.find(({ metric }) => metric === 'write/p50')
  assert.equal(row.median, null)
  assert.match(row.medianReason, /unbounded/)
  assert(row.pairs.every(({ ratio, ratioReason }) => ratio === null && ratioReason))
  assert(!JSON.stringify(compact).includes('Infinity'))
})

test('Mac host qualification survives compaction and report generation without NVIDIA measurements', async () => {
  const settings = {
    macIdleLoadAverage: 4,
    gpuSampleMilliseconds: 1,
    gpuIdleConsecutiveSamples: 3,
    gpuIdleWaitMilliseconds: 1000,
    gpuCommandTimeoutMilliseconds: 100,
  }
  let loadAverage = 2.5
  const gate = createMacHostGate(settings, {
    sample: async () => ({
      observedAt: '2026-10-03T00:00:00.000Z',
      acPower: true,
      t3Code: false,
      loadAverage,
    }),
  })
  const idle = await gate.waitForIdle()
  loadAverage = 9
  const { gpu: window } = await gate.monitorWindow(async () => 'complete')
  assert(window.samples.every((sample) => sample.loadAverage > settings.macIdleLoadAverage))
  const artifact = pairedArtifact()
  artifact.environment.gpu = { gpu: { devices: [], featureStatus: {} } }
  artifact.qualifications = [{ ...idle, kind: 'between-repetitions-gpu', repetition: 0 }]
  const accounting = macCpuAccounting('kern.clockrate: { hz = 100, tick = 10000 }')
  artifact.cpuTickSeconds = accounting.tickSeconds
  artifact.cpuTickSource = accounting.source
  for (const run of artifact.runs) {
    run.gpuIdle = idle
    run.gpuWindows = [{ label: 'output/rolling-logs', idle, window }]
  }
  const compact = JSON.parse(JSON.stringify(await compactEvidence(artifact)))
  assert.deepEqual(compact.qualifications, artifact.qualifications)
  assert.equal(compact.cpuTickSeconds, 0.01)
  assert.deepEqual(compact.cpuTickSource, accounting.source)
  for (const run of compact.runs) {
    assert.deepEqual(run.gpuIdle, idle)
    for (const [name, evidence] of Object.entries({ idle, window })) {
      const retained = run.gpuWindows[0][name]
      assert.deepEqual(retained, { ...evidence, sampleCount: evidence.samples.length })
      for (const field of [
        'utilizationPercent',
        'maxForeignComputeMemoryMiB',
        'maxOwnedComputeMemoryMiB',
      ])
        assert(!Object.hasOwn(retained, field))
    }
  }
  const canvas = structuredClone(artifact)
  canvas.variants = ['ghostty-canvas', 'ghostty-web', 'xterm-dom']
  canvas.runs = artifact.runs.flatMap((run) =>
    run.variant === 'ghostty-webgpu'
      ? [{ ...run, variant: 'ghostty-canvas' }]
      : ['ghostty-web', 'xterm-dom'].map((variant) => ({ ...run, variant })),
  )
  const canvasCompact = JSON.parse(JSON.stringify(await compactEvidence(canvas)))
  assert.deepEqual(pairedRatios(canvasCompact), pairedRatios(canvas))
  for (const counterpart of ['ghostty-web', 'xterm-dom']) {
    const rows = pairedRatios(canvasCompact).filter((row) => row.variant === counterpart)
    assert.equal(rows.length, 7)
    assert(
      rows.every((row) => row.pairs.length === canvas.repetitions && row.gpuSkipped.length === 0),
    )
    assert(
      canvasCompact.runs
        .filter((run) => run.variant === counterpart)
        .every(
          (run) =>
            run.gpuWindows[0].window.foreignActivityMetric ===
            'host-load-average-and-t3-process-presence',
        ),
    )
  }
  const canvasReport = markdown(canvasCompact)
  assert.match(canvasReport, /ghostty-canvas ↔ ghostty-web/)
  assert.match(canvasReport, /ghostty-canvas ↔ xterm-dom/)
  assert.match(canvasReport, /ratios are correlated/)
  assert.match(canvasReport, /does not measure Metal GPU utilization/)
  assert(compact.limitations.includes(idle.limitation))
  assert(!compact.limitations.some((line) => line.includes('NVIDIA total utilization')))
  for (const evidence of [artifact, compact]) {
    const report = markdown(evidence)
    assert.match(report, /AC power/)
    assert.match(report, /T3 Code presence/)
    assert.match(report, /host.load/i)
    assert.match(report, /does not measure Metal GPU utilization/)
    assert.match(report, /CPU comparison accounting bound: 0\.01s/)
    assert.match(report, /Finer CDP counter resolution is unmeasured/)
    assert(!report.includes('GPU windows retain utilization samples'))
    assert(!report.includes('owned/foreign compute-process memory'))
  }
  for (const location of ['qualifications', 'gpuIdle', 'gpuWindows']) {
    const isolated = pairedArtifact()
    if (location === 'qualifications') isolated.qualifications = artifact.qualifications
    if (location === 'gpuIdle') isolated.runs[0].gpuIdle = idle
    if (location === 'gpuWindows') isolated.runs[0].gpuWindows = artifact.runs[0].gpuWindows
    assert.match(markdown(isolated), /does not measure Metal GPU utilization/)
  }
})

test('failed presentation phase survives compact JSON without becoming a qualified pair', async () => {
  const artifact = pairedArtifact()
  artifact.environment.gpu = { gpu: { devices: [], featureStatus: {} } }
  const failure = {
    error: 'Presented green glyph timed out',
    trace: 'failure.trace.json.gz',
    records: { timeOrigin: 1000, markers: [], spans: [], ownership: [] },
    sample: {
      captures: [],
      captureStream: [{ timestamp: 1009, colors: { red: 0, green: 392 } }],
    },
  }
  artifact.runs[0].error = failure.error
  artifact.runs[0].latencyFailure = failure
  const compact = JSON.parse(JSON.stringify(await compactEvidence(artifact)))
  assert.deepEqual(compact.runs[0].latencyFailure, failure)
  assert(pairedRatios(compact).every((row) => row.status === 'incomplete'))
})

test('NVIDIA compaction and report retain utilization and owned/foreign compute-memory evidence', async () => {
  const artifact = pairedArtifact()
  artifact.environment.gpu = { gpu: { devices: [], featureStatus: {} } }
  const evidence = {
    kind: 'window',
    foreignActivityMetric: 'resident-compute-memory-mib',
    qualified: true,
    status: 'qualified',
    settings: { gpuWindowUtilizationPercent: 80, gpuComputeMemoryMiB: 256 },
    samples: [
      {
        utilizationPercent: 20,
        computeMemoryMiB: 128,
        processes: [
          { allowed: true, memoryMiB: 64 },
          { allowed: false, memoryMiB: 128 },
        ],
      },
      {
        utilizationPercent: 40,
        computeMemoryMiB: 192,
        processes: [
          { allowed: true, memoryMiB: 96 },
          { allowed: false, memoryMiB: 192 },
        ],
      },
    ],
  }
  artifact.runs[0].gpuWindows = [{ label: 'output/rolling-logs', window: evidence }]
  const compact = JSON.parse(JSON.stringify(await compactEvidence(artifact)))
  const retained = compact.runs[0].gpuWindows[0].window
  assert.deepEqual(retained.utilizationPercent, [20, 40])
  assert.equal(retained.maxForeignComputeMemoryMiB, 192)
  assert.equal(retained.maxOwnedComputeMemoryMiB, 96)
  assert.equal(retained.sampleCount, 2)
  assert.equal(retained.foreignActivityMetric, evidence.foreignActivityMetric)
  assert.deepEqual(retained.settings, evidence.settings)
  assert(compact.limitations.some((line) => line.includes('NVIDIA total utilization')))
  for (const value of [artifact, compact]) {
    const report = markdown(value)
    assert.match(
      report,
      /GPU windows retain utilization samples, owned\/foreign compute-process memory/,
    )
    assert(!report.includes('Metal GPU utilization'))
  }
})

test('compaction preserves paired frame-builder identities and ratios', async () => {
  const artifact = pairedArtifact()
  artifact.environment.gpu = { gpu: { devices: [], featureStatus: {} } }
  artifact.qualifications = []
  artifact.runs = artifact.runs.flatMap((run) =>
    run.variant === 'ghostty-webgpu'
      ? ['js', 'zig'].map((frameBuilder) => ({ ...run, frameBuilder }))
      : [run],
  )
  const compact = await compactEvidence(artifact)
  assert.deepEqual(
    compact.runs.map((run) => run.frameBuilder),
    artifact.runs.map((run) => run.frameBuilder),
  )
  assert.deepEqual(pairedRatios(compact), pairedRatios(artifact))
})

test('compaction retains preparation failures and incomplete paired verdicts', async () => {
  const artifact = pairedArtifact()
  artifact.environment.gpu = { gpu: { devices: [], featureStatus: {} } }
  artifact.qualifications = []
  for (const run of artifact.runs) {
    run.info = { adapter: {} }
    run.gpuWindows = []
  }
  const failed = artifact.runs[0]
  failed.error = 'preparation failed'
  delete failed.info
  delete failed.idle
  delete failed.output
  delete failed.latency
  const compact = await compactEvidence(artifact, '.')
  assert.equal(compact.runs[0].error, failed.error)
  assert(compact.pairedRatios.every(({ status }) => status === 'incomplete'))
})

test('compaction preserves rejected GPU window diagnostics through JSON serialization', async () => {
  for (const failure of [
    {
      status: 'failed',
      qualified: false,
      reason: 'External NVIDIA compute activity detected during measurement',
      baselineForeignComputePids: [123],
      newForeignComputePids: [999],
      samples: [{ utilizationPercent: 20, processes: [{ pid: 999, memoryMiB: 128 }] }],
    },
    {
      status: 'failed',
      qualified: false,
      reason: 'GPU utilization exceeds measurement limit',
      samples: [{ utilizationPercent: 81, processes: [] }],
    },
    {
      status: 'failed',
      qualified: false,
      reason: 'NVIDIA sampling failed',
      samplingError: { code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true },
      samples: [],
    },
  ]) {
    const artifact = pairedArtifact()
    artifact.environment.gpu = { gpu: { devices: [], featureStatus: {} } }
    artifact.qualifications = []
    const rejected = artifact.runs[0]
    rejected.error = failure.reason
    rejected.gpuWindows = [{ label: 'output/ascii', failure }]
    const compact = JSON.parse(JSON.stringify(await compactEvidence(artifact)))
    assert.deepEqual(compact.runs[0].gpuWindows, rejected.gpuWindows)
    assert(compact.pairedRatios.every(({ status }) => status === 'incomplete'))
  }
})

test('trace latency metadata names PNG capture while ordinary mode keeps presentation endpoints', () => {
  for (const options of [
    { platform: 'linux', headless: true },
    { platform: 'linux', headless: false },
    { platform: 'darwin', headless: false },
    { platform: 'win32', headless: true },
  ]) {
    assert.equal(
      comparisonLatencyEndpoint({ ...options, tracing: true }),
      'keydown/write to first screencast PNG containing the intended colored glyph',
    )
    const expected =
      options.platform === 'linux' && options.headless
        ? 'keydown/write to compositor presentation ack (headless-shell, on-demand, not vsync)'
        : 'keydown/write to Chrome presentation feedback (terminal rendered frame)'
    assert.equal(comparisonLatencyEndpoint({ ...options, tracing: false }), expected)
  }
})

test('native renderer pairs retain generic counterpart values and per-session identity', () => {
  const artifact = pairedArtifact()
  const nativeRuns = artifact.runs.filter((run) => run.variant === 'ghostty-webgpu')
  const otherRuns = artifact.runs.filter((run) => run.variant === 'xterm-webgl')
  const counterparts = {
    'ghostty-webgl': 'xterm-webgl',
    'ghostty-canvas': 'ghostty-web',
    'ghostty-dom': 'xterm-dom',
  }
  artifact.variants = Object.keys(counterparts).concat(Object.values(counterparts))
  artifact.runs = Object.entries(counterparts).flatMap(([native, counterpart]) => [
    ...nativeRuns.map((run) => ({ ...run, variant: native })),
    ...otherRuns.map((run) => ({ ...run, variant: counterpart })),
  ])
  artifact.frameBuilders = ['zig']
  const rows = pairedRatios(artifact)
  assert.equal(rows.length, 28)
  for (const [native, counterpart] of Object.entries(counterparts)) {
    const expected = native === 'ghostty-canvas' ? [counterpart, 'xterm-dom'] : [counterpart]
    const selected = rows.filter((row) => row.nativeVariant === native)
    assert.equal(selected.length, 7 * expected.length)
    for (const row of selected) {
      assert(expected.includes(row.variant))
      assert.equal(row.status, 'pass')
      assert.equal(row.frameBuilder, undefined)
      assert.equal(row.pairs[1].counterpart, 100)
      assert.equal(row.pairs[1].sessionId, 'browser-session')
    }
  }
  artifact.runs.find((run) => run.variant === 'ghostty-web').sessionId = 'foreign-session'
  assert(
    pairedRatios(artifact)
      .filter((row) => row.nativeVariant === 'ghostty-canvas' && row.variant === 'ghostty-web')
      .every((row) => row.status === 'incomplete'),
  )
  const report = markdown(artifact)
  assert(report.includes('xterm removed its canvas renderer'))
  assert(report.includes('ghostty-canvas ↔ ghostty-web'))
  assert(report.includes('ghostty-canvas ↔ xterm-dom'))
  assert(report.includes('ratios are correlated'))
  assert(report.includes('| Native | Counterpart |'))
})

test('omitted phases never consume stale samples or receive a paired verdict', () => {
  const artifact = pairedArtifact()
  artifact.phases = ['latency', 'output']
  artifact.fixtures = ['ascii', 'sgr']
  artifact.frameBuilders = ['js']
  artifact.runs = artifact.runs.map((run) =>
    run.variant === 'ghostty-webgpu' ? { ...run, frameBuilder: 'js' } : run,
  )
  for (const run of artifact.runs) {
    run.parse = { ascii: { bytes: 1000, milliseconds: 1, validation: { qualified: true } } }
    run.burst = { ascii: { intervals: [1] } }
    run.refreshPeriod = 16.67
  }
  assert(summaries(artifact).every((row) => !/^(idle|parse|burst)\//.test(row.metric)))
  for (const row of pairedRatios(artifact).filter((entry) => entry.metric.startsWith('idle/'))) {
    assert.equal(row.status, 'not measured')
    assert.deepEqual(row.pairs, [])
    assert.equal(row.median, null)
  }
  assert(
    pairedRatios(artifact)
      .filter((entry) => !entry.metric.startsWith('idle/'))
      .every((row) => row.status === 'pass'),
  )
  const report = markdown(artifact)
  for (const metric of ['idle/cpu', 'parse/ascii', 'parse/sgr', 'burst/ascii/p95', 'memory/10k'])
    assert(report.includes(`| ${metric} | not measured | not measured |`))
  const idlePair = report
    .split('\n')
    .find((line) => line.includes('↔') && line.includes('idle/cpu/renderer | not measured'))
  assert(idlePair.includes('| — | — | not measured |'))
  assert(!idlePair.includes('incomplete'))
})

test('skipped latency emits not measured while selected missing output stays incomplete', () => {
  const artifact = pairedArtifact()
  artifact.phases = ['output']
  artifact.runs = []
  for (const row of pairedRatios(artifact)) {
    const expected = row.metric.startsWith('output/') ? 'incomplete' : 'not measured'
    assert.equal(row.status, expected)
  }
  const report = markdown(artifact)
  for (const metric of ['write/p50', 'write/p95', 'input/p50', 'input/p95'])
    assert(report.includes(`| ${metric} | not measured | not measured |`))
})

test('benchmark row tracing records actual DOM commits including newly replaced rows', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?trace' } })
  try {
    const tracing = new ComparisonTracing()
    const children = []
    const makeRow = () => ({
      replaceWith(next) {
        children[0] = next
      },
    })
    children[0] = makeRow()
    const surface = {
      container: { firstElementChild: { children } },
      paint(row) {
        const previous = children[row.y]
        if (previous) previous.replaceWith(makeRow())
      },
    }
    const renderer = {
      backend: 'dom',
      scheduler: {},
      surface,
      rowsToPaint() {},
      notifyWrite() {},
      drawFrame(row) {
        surface.paint(row)
      },
    }
    tracing.nativeRenderer(0, renderer)
    tracing.begin()
    renderer.drawFrame({ y: 0 })
    renderer.drawFrame({ y: 0 })
    renderer.drawFrame({ y: 9 })
    const records = tracing.end()
    assert.equal(records.spans.filter((span) => span.operation === 'drawFrame').length, 3)
    assert.equal(
      records.spans.filter(
        (span) => span.category === 'commands' && span.operation === 'replaceWith',
      ).length,
      2,
    )
    assert.equal(records.ownership[0].backend, 'dom')
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original)
    else delete globalThis.location
  }
})

test('xterm DOM tracing follows replacement row instances and rejects non-committing frames', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?trace' } })
  try {
    const tracing = new ComparisonTracing()
    const renderer = {
      _rowElements: [{ replaceChildren() {} }],
      _rowFactory: { createRow() {} },
      renderRows(commit) {
        if (commit) this._rowElements[0].replaceChildren()
      },
    }
    const service = { _renderer: { value: renderer }, _renderDebouncer: {}, refreshRows() {} }
    tracing.xtermDom(0, { _core: { _renderService: service, _inputHandler: { parse() {} } } })
    tracing.begin()
    renderer.renderRows(true)
    renderer._rowElements = [{ replaceChildren() {} }]
    renderer.renderRows(true)
    renderer.renderRows(false)
    const records = tracing.end()
    assert.equal(records.spans.filter((span) => span.operation === 'renderRows').length, 3)
    assert.equal(records.spans.filter((span) => span.operation === 'replaceChildren').length, 2)
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original)
    else delete globalThis.location
  }
})

test('both GPU reports separate explicit builders beside the shared WebGL control', () => {
  const artifact = pairedArtifact()
  const nativeRuns = artifact.runs.filter((run) => run.variant === 'ghostty-webgpu')
  artifact.variants = ['ghostty-webgpu', 'ghostty-webgl', 'xterm-webgl']
  artifact.frameBuilders = ['js', 'zig']
  artifact.runs = artifact.runs
    .filter((run) => run.variant === 'xterm-webgl')
    .concat(
      ['ghostty-webgpu', 'ghostty-webgl'].flatMap((variant) =>
        ['js', 'zig'].flatMap((frameBuilder) =>
          nativeRuns.map((run) => ({
            ...run,
            variant,
            frameBuilder,
            latency: {
              ...run.latency,
              write: run.latency.write.map((value) => value * (frameBuilder === 'zig' ? 2 : 1)),
            },
          })),
        ),
      ),
    )
  const rows = pairedRatios(artifact)
  assert.equal(rows.length, 28)
  for (const variant of ['ghostty-webgpu', 'ghostty-webgl']) {
    const selected = rows.filter(
      (row) => row.nativeVariant === variant && row.metric === 'write/p50',
    )
    assert.deepEqual(
      selected.map((row) => row.frameBuilder),
      ['js', 'zig'],
    )
    assert.deepEqual(
      selected.map((row) => row.median),
      [0.5, 1],
    )
    assert(selected.every((row) => row.status === 'pass' && row.repetitions === 3))
  }
  const report = markdown(artifact)
  assert(
    report.includes(
      '| Measure | ghostty-webgpu-js | ghostty-webgpu-zig | ghostty-webgl-js | ghostty-webgl-zig | xterm-webgl |',
    ),
  )
  assert(report.includes('| write/p50 | 10.00 ms | 20.00 ms | 10.00 ms | 20.00 ms | 100.00 ms |'))
  assert(report.includes('ghostty-webgl-js ↔ xterm-webgl'))
  assert(report.includes('ghostty-webgl-zig ↔ xterm-webgl'))
})

test('historical WebGL measurements keep their unlabeled identity beside labeled WebGPU', () => {
  const artifact = pairedArtifact()
  const nativeRuns = artifact.runs.filter((run) => run.variant === 'ghostty-webgpu')
  artifact.variants = ['ghostty-webgpu', 'ghostty-webgl', 'xterm-webgl']
  artifact.frameBuilders = ['zig']
  artifact.runs = artifact.runs
    .map((run) => (run.variant === 'ghostty-webgpu' ? { ...run, frameBuilder: 'zig' } : run))
    .concat(nativeRuns.map((run) => ({ ...run, variant: 'ghostty-webgl' })))
  const rows = pairedRatios(artifact)
  assert.equal(rows.length, 14)
  assert(
    rows
      .filter((row) => row.nativeVariant === 'ghostty-webgl')
      .every((row) => row.frameBuilder === undefined && row.status === 'pass'),
  )
  const report = markdown(artifact)
  assert(report.includes('| Measure | ghostty-webgpu-zig | ghostty-webgl | xterm-webgl |'))
  assert(report.includes('ghostty-webgl ↔ xterm-webgl'))
  assert(!report.includes('ghostty-webgl-zig'))
})

test('native work summaries are descriptive and leave paired CPU verdicts unchanged', () => {
  const artifact = pairedArtifact()
  artifact.processCounters = true
  const baseline = pairedRatios(artifact)
  for (const run of artifact.runs)
    run.output.cpu.workCounters = {
      status: 'measured',
      channels: {
        renderer: {
          instructions: 100,
          cycles: 200,
          cpuSeconds: 1,
          pCoreShare: 0.75,
          effectiveClockGHz: 2,
          energyJ: null,
        },
      },
      limitations: ['User-space counters'],
    }
  assert.deepEqual(pairedRatios(artifact), baseline)
  const rows = summaries(artifact)
  assert.equal(rows.find((row) => row.metric === 'output/work/renderer/instructions').median, 100)
  assert.equal(rows.find((row) => row.metric === 'output/cpu-seconds/renderer').median, 10)
  assert(!rows.some((row) => row.metric.endsWith('/energyJ')))
  assert.match(markdown(artifact), /Process work counters/)
  assert.match(markdown(artifact), /User-space counters/)
  for (const run of artifact.runs)
    run.output.cpu.workCounters = {
      status: 'skipped',
      reason: 'Hardware permission denied',
    }
  assert(!summaries(artifact).some((row) => row.metric.includes('/work/')))
  assert.match(markdown(artifact), /Hardware permission denied/)
  assert.deepEqual(pairedRatios(artifact), baseline)
})

test('compact evidence retains native coverage and boundaries without copying raw snapshots', async () => {
  const artifact = pairedArtifact()
  artifact.processCounters = true
  artifact.environment.gpu = { gpu: { devices: [], featureStatus: {} } }
  const evidence = {
    status: 'measured',
    channels: { renderer: { instructions: 100, cycles: 200 } },
    metadata: { source: 'perf_event_open' },
    coverage: { matched: [1], errors: [] },
    processes: [{ pid: 1, identity: '42' }],
    boundary: { before: { native: { requested: 1, completed: 2 } } },
    snapshots: { before: { large: 'raw' }, after: { large: 'raw' } },
  }
  for (const run of artifact.runs) run.output.cpu.workCounters = evidence
  const compact = await compactEvidence(artifact)
  assert.equal(compact.processCounters, true)
  const { snapshots, ...retained } = evidence
  for (const run of compact.runs) assert.deepEqual(run.output.cpu.workCounters, retained)
  assert.deepEqual(evidence.snapshots, snapshots)
  assert.deepEqual(pairedRatios(compact), pairedRatios(artifact))
})
