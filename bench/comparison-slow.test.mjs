import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  corpus,
  fixtureNames,
  fixtureText,
  isRollingFixture,
  rollingByteCount,
  rollingFixture,
  rollingInputs,
  settings,
} from './comparison-fixtures.ts'
import { framedInputHash } from './comparison-build.ts'
import { frameMetricDeltas } from './comparison-metrics.ts'
import { pacedBurst } from './comparison-protocol.ts'
import { GhosttyRuntime } from '../src/core/runtime.ts'
import { canvasScrollPlan } from '../src/render/canvas/scroll.ts'

const logs = await readFile(new URL('./fixtures/git-history.txt', import.meta.url), 'utf8')
const encoder = new TextEncoder()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

const frozen = [
  {
    name: 'rolling-logs',
    text: '6a5bb7da8247bd5d1898d97a815e574fbf70831b7f9bc0a183cc74a7acde839b',
    corpus: '5b962d02c1255260d6a332719dacc083515893ed355d0aa3695f40541fc08834',
    framed: '044a938134f9d0999f3d6c46ac931dea40c0d901806e3222b1ac769fda12115f',
    frames: 259,
    bytes: 1059649,
    tail: 2881,
  },
  {
    name: 'rolling-unicode-logs',
    text: '3aa4174307c81da135fa959020348bfc7e5e0efac64d42f02c21194307cfe298',
    corpus: '75b5635ce065251b6722beea1025e877add8f5e7a0ad26dcf83fdef4b5d5c222',
    framed: '39e24207780b58142b88780d09acca0ef7599b14b110f5cd21c496afcb979aa8',
    frames: 262,
    bytes: 1070200,
    tail: 1149,
  },
]

test('frozen rolling fixture text, corpus, framing and settings retain their identities', () => {
  assert.equal(
    hash(JSON.stringify(settings)),
    '3d62c5bce7b09041cfa00a4792cccfa62d59f12f120002a9622319d7de374c80',
  )
  for (const expected of frozen) {
    const fixture = rollingFixture(logs, settings.corpusBytes, settings.chunkBytes, expected.name)
    assert.equal(hash(fixtureText(expected.name, logs)), expected.text)
    assert.equal(hash(fixture.bytes), expected.corpus)
    assert.equal(framedInputHash(fixture.chunks), expected.framed)
    assert.equal(fixture.chunks.length, expected.frames)
    assert.equal(fixture.bytes.length, expected.bytes)
    assert.equal(fixture.chunks.at(-1).length, expected.tail)
  }
})

test('rolling-slow emits exactly one distinct fitting ASCII line per frame', () => {
  const fixture = rollingFixture(logs, settings.corpusBytes, settings.chunkBytes, 'rolling-slow')
  assert(fixtureNames.includes('rolling-slow'))
  assert(isRollingFixture('rolling-slow'))
  assert(!isRollingFixture('logs'))
  assert.equal(fixtureText('rolling-slow', logs), fixtureText('rolling-slow', 'ignored source'))
  assert.equal(fixture.chunks.length, 35 * 1024)
  assert.equal(fixture.bytes.length, 35 * 1024 * 30)
  assert.deepEqual(Buffer.concat(fixture.chunks), Buffer.from(fixture.bytes))
  const strings = rollingInputs(fixture, 'string')
  assert.equal(rollingInputs(fixture, 'bytes'), fixture.chunks)
  for (const [index, text] of strings.entries()) {
    assert.equal(text, `${String(index % 1024).padStart(4, '0')} INFO rolling-slow event\r\n`)
    assert.match(text, /^[\x20-\x7e]+\r\n$/)
    assert(text.length - 2 < settings.columns, 'One line must occupy one visible row')
    assert.deepEqual(encoder.encode(text), fixture.chunks[index])
    assert.notEqual(text, strings[(index + 1) % strings.length])
  }
})

test('rolling-slow cycles reconstruct identical bytes with exact partial-cycle accounting', () => {
  const fixture = rollingFixture(logs, 1, settings.chunkBytes, 'rolling-slow')
  assert.equal(fixture.chunks.length, 1024)
  assert.deepEqual(fixture, rollingFixture(logs, 1, settings.chunkBytes, 'rolling-slow'))
  assert.deepEqual(fixture.bytes, encoder.encode(corpus(fixtureText('rolling-slow', logs), 1)))
  for (const frames of [0, 1, 12, 1023, 1024, 1025, 2051, settings.outputFrames]) {
    let bytes = 0
    for (let frame = 0; frame < frames; frame++)
      bytes += fixture.chunks[frame % fixture.chunks.length].length
    assert.equal(rollingByteCount(fixture, frames), bytes)
  }
  assert.notEqual(framedInputHash(fixture.chunks), framedInputHash([fixture.bytes]))
})

test('comparison entry dispatches the same rolling-slow frames at its existing cadence for all comparators', async () => {
  const source = await readFile(new URL('./comparison-entry.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function rollingBurst(')
  const end = source.indexOf('\nasync function history(', start)
  assert(start >= 0 && end > start)
  const functions = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
  for (const variant of ['ghostty-canvas', 'ghostty-web', 'xterm-dom']) {
    for (const path of ['bytes', 'string']) {
      const frames = []
      let cadence = 0
      let resets = 0
      const burst = new Function(
        'context',
        `const { rollingFixture, rollingInputs, rollingByteCount, settings, logs, current,
          drivers, writeAll, settle, pacedBurst, frame, frameMetricDeltas, isRollingFixture,
          corpus, fixtureText, encoder, performance } = context;
         ${functions}
         return burst;`,
      )({
        rollingFixture,
        rollingInputs,
        rollingByteCount,
        settings,
        logs,
        current: { variant, path, count: 1 },
        drivers: [{ write: async (chunk) => frames.push(chunk) }],
        writeAll: async (text) => {
          assert.equal(text, '\x1b[3J\x1b[2J\x1b[H')
          resets++
        },
        settle: async () => {},
        pacedBurst,
        frame: async () => ++cadence,
        frameMetricDeltas,
        isRollingFixture,
        corpus,
        fixtureText,
        encoder,
        performance: { now: () => 0 },
      })
      const result = await burst('rolling-slow', 16)
      assert.equal(resets, 1)
      assert.equal(cadence, 17)
      assert.equal(frames.length, 16)
      assert.equal(result.fixture, 'rolling-slow')
      assert.equal(result.bytes, 16 * 30)
      assert.equal(result.chunkCount, 35 * 1024)
      assert.equal(result.completedCycles, 0)
      assert.equal(result.nextChunk, 16)
      assert.equal(result.reset, 'corpus-start')
      assert.deepEqual(
        frames.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk)),
        rollingFixture(
          logs,
          settings.corpusBytes,
          settings.chunkBytes,
          'rolling-slow',
        ).chunks.slice(0, 16),
      )
    }
  }
})

test('real native 40x12 viewports advance one row and select overlap on both write paths', async () => {
  const fixture = rollingFixture(logs, 1, settings.chunkBytes, 'rolling-slow')
  const runtime = await GhosttyRuntime.create()
  const sequences = []
  try {
    for (const path of ['bytes', 'string']) {
      const terminal = runtime.createTerminal({ columns: settings.columns, rows: settings.rows })
      const state = runtime.createRenderState(terminal)
      try {
        terminal.write('\x1b[?25l')
        state.update()
        let previous = new Map(state.readRows().map((row) => [row.y, JSON.stringify(row.cells)]))
        state.acknowledge()
        const sequence = []
        const chunks = rollingInputs(fixture, path)
        for (let frame = 0; frame < 32; frame++) {
          terminal.write(chunks[frame])
          state.update()
          const rows = state.readRows()
          const next = new Map(rows.map((row) => [row.y, JSON.stringify(row.cells)]))
          const lines = rows.map((row) =>
            row.cells
              .map((cell) => cell.text)
              .join('')
              .trimEnd(),
          )
          assert.equal(
            lines[Math.min(frame, settings.rows - 2)],
            `${String(frame).padStart(4, '0')} INFO rolling-slow event`,
          )
          assert.equal(lines.at(-1), '')
          if (frame >= settings.rows) {
            const plan = canvasScrollPlan(previous, next, settings.rows)
            assert.equal(plan.offset, -1)
            assert.equal(plan.reused.size, settings.rows - 2)
          }
          sequence.push(lines)
          previous = next
          state.acknowledge()
        }
        sequences.push(sequence)
      } finally {
        state.dispose()
        terminal.dispose()
      }
    }
    assert.deepEqual(sequences[0], sequences[1])
  } finally {
    runtime.dispose()
  }
})
