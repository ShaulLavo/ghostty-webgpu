import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as fixtures from './comparison-fixtures.ts'
import { pacedBurst } from './comparison-protocol.ts'
import { frameMetricDeltas } from './comparison-metrics.ts'

const source = await readFile(new URL('./comparison-entry.ts', import.meta.url), 'utf8')
const logs = await readFile(new URL('./fixtures/git-history.txt', import.meta.url), 'utf8')
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end))
const initialize = section('async function initialize(', 'async function smokeParse(')
const bursts = section('async function rollingBurst(', 'async function history(')
const encoder = new TextEncoder()

function writeBytes(write, path, label) {
  if (path === 'string') {
    assert.equal(typeof write, 'string', `${label} must be a string`)
    return encoder.encode(write)
  }
  assert(write instanceof Uint8Array, `${label} must be bytes`)
  return write
}

// Execute the actual browser entry functions with external I/O supplied by the test.
const entry = new Function(
  'bindings',
  `${Object.keys(fixtures)
    .map((name) => `const ${name} = bindings.${name};`)
    .join('\n')}
   const { pacedBurst, frameMetricDeltas, fetch, performance, TextEncoder, TextDecoder } = bindings;
   let current, logs, preparedBursts;
   const drivers = [{ write: async (data) => bindings.writes.push(data), frameMetrics: () => undefined }];
   const encoder = new TextEncoder();
   const input = (text) => current.path === 'bytes' ? encoder.encode(text) : text;
   const writeAll = async (text) => drivers[0].write(input(text));
   const frame = async () => 1;
   const settle = async () => {};
   ${transpiler.transformSync(initialize + bursts)}
   return { initialize, burst }`,
)

for (const path of ['bytes', 'string']) {
  test(`${path} burst prepares every fixture before the measured span and preserves tick bytes`, async () => {
    let measured = false
    let encodes = 0
    class BoundaryEncoder extends TextEncoder {
      encode(text) {
        encodes++
        assert.equal(measured, false, 'fixture encoding inside measured span')
        return super.encode(text)
      }
    }
    class BoundaryDecoder extends TextDecoder {
      decode(bytes, options) {
        assert.equal(measured, false, 'fixture decoding inside measured span')
        return super.decode(bytes, options)
      }
    }
    const writes = []
    const harness = entry({
      ...fixtures,
      pacedBurst,
      frameMetricDeltas,
      writes,
      TextEncoder: BoundaryEncoder,
      TextDecoder: BoundaryDecoder,
      performance,
      fetch: async () => ({ text: async () => logs }),
      rollingFixture: (...args) => {
        assert.equal(measured, false, 'rolling fixture preparation inside measured span')
        return fixtures.rollingFixture(...args)
      },
      rollingInputs: (...args) => {
        assert.equal(measured, false, 'rolling input conversion inside measured span')
        return fixtures.rollingInputs(...args)
      },
      fixtureText: (...args) => {
        assert.equal(measured, false, 'fixture text preparation inside measured span')
        return fixtures.fixtureText(...args)
      },
      corpus: (...args) => {
        assert.equal(measured, false, 'corpus preparation inside measured span')
        return fixtures.corpus(...args)
      },
    })
    new BoundaryEncoder().encode('known-good preparation')
    await harness.initialize({ path, variant: 'ghostty-dom', count: 1 })
    assert(encodes > 0, 'known-good preparation encoder must run')
    for (const name of fixtures.fixtureNames) {
      const expected = fixtures.isRollingFixture(name)
        ? fixtures.rollingInputs(
            fixtures.rollingFixture(
              logs,
              fixtures.settings.corpusBytes,
              fixtures.settings.chunkBytes,
              name,
            ),
            path,
          )
        : [fixtures.corpus(fixtures.fixtureText(name, logs), fixtures.settings.chunkBytes)]
      const ticks = expected.length + 2
      writes.length = 0
      measured = true
      let result
      try {
        result = await harness.burst(name, ticks)
      } finally {
        measured = false
      }
      assert.equal(writes.length, ticks + 1)
      assert.equal(
        new TextDecoder().decode(writeBytes(writes[0], path, `${name} reset`)),
        '\x1b[3J\x1b[2J\x1b[H',
      )
      let bytes = 0
      for (let tick = 0; tick < ticks; tick++) {
        const actual = writeBytes(writes[tick + 1], path, `${name} tick ${tick}`)
        const chunk = expected[tick % expected.length]
        const wanted = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
        assert.deepEqual(actual, wanted, `${name} tick ${tick}`)
        bytes += wanted.length
      }
      assert.equal(result.bytes, bytes)
    }
  })
}
