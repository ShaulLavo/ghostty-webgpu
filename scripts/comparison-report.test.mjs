import { PNG } from 'pngjs'
import { ink } from './comparison-pixels.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { droppedFrames, markdown, order, quantile, summaries } from './comparison-report.mjs'
import { cpuSample, verifyHash, withDeadline } from './comparison-guards.mjs'
// Package metadata is pinned by resolver provenance; keep the tooling suites under this entry.
import './comparison-trace.test.mjs'
import './comparison-attribution.test.mjs'
import './comparison-options.test.mjs'
import {
  expectedScreen,
  inputChunks,
  pacedBurst,
  parseChunks,
  qualifyScreen,
  synchronousWrite,
} from '../bench/comparison-protocol.ts'

test('benchmark package metadata matches native resolver provenance', () => {
  const packageBytes = readFileSync(new URL('../package.json', import.meta.url))
  const inputBytes = readFileSync(
    new URL('./config-resolver-native/native-inputs.json', import.meta.url),
  )
  const inputs = JSON.parse(inputBytes)
  const nativeRoot = new URL('../native/config-resolver/', import.meta.url)
  const markerName = existsSync(new URL('bootstrap.json', nativeRoot))
    ? 'bootstrap.json'
    : 'manifest.json'
  const marker = JSON.parse(readFileSync(new URL(markerName, nativeRoot)))
  assert.deepEqual(
    inputs.ownedFiles.find((file) => file.path === 'package.json'),
    {
      path: 'package.json',
      mode: '100644',
      bytes: packageBytes.length,
      sha256: createHash('sha256').update(packageBytes).digest('hex'),
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
