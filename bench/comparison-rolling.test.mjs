import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { GhosttyRuntime } from '../src/core/runtime.ts'
import {
  corpus,
  fixtureText,
  rollingByteCount,
  rollingFixture,
  rollingInputs,
  settings,
  unicodePromptLogs,
} from './comparison-fixtures.ts'
import { framedInputHash } from './comparison-build.ts'
import { frameMetricDeltas } from './comparison-metrics.ts'

const logs = await readFile(new URL('./fixtures/git-history.txt', import.meta.url), 'utf8')
const fixture = rollingFixture(logs)
const encoder = new TextEncoder()

test('rolling real-history chunks preserve every source byte and complete UTF-8 codepoint', () => {
  assert(logs.includes('–'), 'Real history must preserve the original en dash')
  assert.deepEqual(
    fixture.bytes,
    encoder.encode(corpus(fixtureText('logs', logs), settings.corpusBytes)),
  )
  assert.deepEqual(Buffer.concat(fixture.chunks), Buffer.from(fixture.bytes))
  const strings = rollingInputs(fixture, 'string')
  const bytes = rollingInputs(fixture, 'bytes')
  assert.equal(bytes, fixture.chunks)
  for (let index = 0; index < bytes.length; index++) {
    assert(bytes[index].length > 0 && bytes[index].length <= settings.chunkBytes)
    assert.deepEqual(encoder.encode(strings[index]), bytes[index])
  }
  const boundaries = rollingFixture('abc日本語🧪\n', 120, 4)
  for (const chunk of boundaries.chunks)
    assert.deepEqual(encoder.encode(new TextDecoder('utf-8', { fatal: true }).decode(chunk)), chunk)
  for (const size of [0, 1, 3, 4.5, NaN]) assert.throws(() => rollingFixture(logs, 100, size))
})

test('rolling input resets deterministically and counts exact bytes through corpus wraps', () => {
  assert.deepEqual(rollingFixture(logs), fixture)
  for (const frames of [0, 1, 3, 1200, 2700]) {
    let bytes = 0
    for (let frame = 0; frame < frames; frame++)
      bytes += fixture.chunks[frame % fixture.chunks.length].length
    assert.equal(rollingByteCount(fixture, frames), bytes)
  }
  const repeated = [encoder.encode(corpus(fixtureText('logs', logs), settings.chunkBytes))]
  assert.notEqual(framedInputHash(repeated), framedInputHash(fixture.chunks))
  assert.notEqual(framedInputHash(fixture.chunks), framedInputHash([fixture.bytes]))
})

test('synthetic Unicode rolling logs preserve history and periodically add shell and CJK lines', () => {
  const source = Array.from({ length: 32 }, (_, index) => `commit ${index}`).join('\n') + '\n'
  const decorated = unicodePromptLogs(source)
  const original = decorated
    .split('\n')
    .filter((line) => !line.startsWith('❯') && !line.startsWith('┌'))
  assert.equal(original.join('\n'), source)
  assert.equal(decorated.split('❯ git log --oneline').length - 1, 8)
  assert.equal(decorated.split('┌─ 状態: 日本語 中文 ─┐').length - 1, 2)
  const synthetic = rollingFixture(
    logs,
    settings.corpusBytes,
    settings.chunkBytes,
    'rolling-unicode-logs',
  )
  assert.deepEqual(
    synthetic.bytes,
    encoder.encode(corpus(fixtureText('rolling-unicode-logs', logs), settings.corpusBytes)),
  )
  assert.deepEqual(Buffer.concat(synthetic.chunks), Buffer.from(synthetic.bytes))
  assert.notEqual(framedInputHash(synthetic.chunks), framedInputHash(fixture.chunks))
  for (const chunk of synthetic.chunks) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(chunk)
    assert.deepEqual(encoder.encode(text), chunk)
    assert(text.includes('❯'), 'Each output chunk must exercise a Unicode prompt')
  }
})

test('burst metric deltas preserve missing baseline counters and unavailable control metrics', () => {
  const before = [undefined, { submittedFrames: 3 }, { submittedFrames: 3, zigFrames: 3 }]
  const after = [undefined, { submittedFrames: 1203 }, { submittedFrames: 1203, zigFrames: 1195 }]
  const metrics = frameMetricDeltas(before, after)
  assert.deepEqual(metrics[0], {
    terminal: 0,
    before: undefined,
    after: undefined,
    delta: undefined,
  })
  assert.deepEqual(metrics[1].delta, { submittedFrames: 1200 })
  assert.deepEqual(metrics[2].delta, {
    submittedFrames: 1200,
    zigFrames: 1192,
  })
  assert.equal(metrics[2].before, before[2])
  assert.equal(metrics[2].after, after[2])
})

test('synthetic Unicode rolling bytes advance real-core viewports and expose prompt glyphs', async () => {
  const synthetic = rollingFixture(
    logs,
    settings.corpusBytes,
    settings.chunkBytes,
    'rolling-unicode-logs',
  )
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: settings.columns, rows: settings.rows })
  const state = runtime.createRenderState(terminal)
  try {
    let previous
    let promptViewports = 0
    for (let frame = 0; frame < 2700; frame++) {
      terminal.write(synthetic.chunks[frame % synthetic.chunks.length])
      const current = viewport(state)
      assert.notEqual(current, previous, `Synthetic viewport repeats at frame ${frame + 1}`)
      if (current.includes('❯')) promptViewports++
      previous = current
    }
    assert(promptViewports > 1350, 'Unicode prompt must remain visible in most output frames')
  } finally {
    runtime.dispose()
  }
})

function viewport(state) {
  return state
    .snapshot()
    .rows.map((row) => row.cells.map((cell) => cell.text).join(''))
    .join('\n')
}

test('real Ghostty core sees changing rolling viewports for all 2700 frames on both write paths', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: settings.columns, rows: settings.rows })
  const state = runtime.createRenderState(terminal)
  try {
    const repeated = corpus(fixtureText('logs', logs), settings.chunkBytes)
    terminal.write(repeated)
    const knownRepeated = viewport(state)
    terminal.write(repeated)
    assert.equal(
      viewport(state),
      knownRepeated,
      'Known stock logs case must expose the repeated viewport',
    )
    const viewports = []
    for (const path of ['bytes', 'string']) {
      terminal.write('\x1bc')
      const chunks = rollingInputs(fixture, path)
      const digest = createHash('sha256')
      let previous
      const checkpoints = {}
      for (let frame = 0; frame < 2700; frame++) {
        terminal.write(chunks[frame % chunks.length])
        const current = viewport(state)
        assert.notEqual(current, previous, `${path} viewport repeats at frame ${frame + 1}`)
        digest.update(current).update('\0')
        if (frame === 1199 || frame === 2699) checkpoints[frame + 1] = current
        previous = current
      }
      viewports.push({ sha256: digest.digest('hex'), checkpoints })
    }
    assert.deepEqual(
      viewports[0],
      viewports[1],
      'Byte and string paths must have identical real-core viewport sequences',
    )
  } finally {
    runtime.dispose()
  }
})
