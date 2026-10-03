import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const runner = await readFile(new URL('./comparison-runner.mjs', import.meta.url), 'utf8')
const start = runner.indexOf('async function qualifiedWindow(')
const end = runner.indexOf('\nasync function presentedLatency(', start)
assert(start >= 0 && end > start)
const createWindow = new Function(
  'refreshGpuOwnership',
  'gpuGate',
  's',
  `${runner.slice(start, end)}; return qualifiedWindow`,
)

test('every measured output fixture keeps the existing measured GPU sampling cadence', async () => {
  const settings = { gpuMeasuredSampleMilliseconds: 1000, gpuSampleMilliseconds: 250 }
  const labels = [
    ['idle', 1000],
    ['latency', 1000],
    ['delayed-write', 1000],
    ['output/ascii', 1000],
    ['output/rolling-logs', 1000],
    ['output/logs', 1000],
    ['mount', 250],
    ['burst/ascii', 250],
    ['burst/rolling-logs', 250],
    ['parse/rolling-logs', 250],
    ['parser/rolling-logs', 250],
  ]
  for (const [label, expected] of labels) {
    const calls = []
    const idle = { qualified: true }
    const gpu = { qualified: true }
    const value = { label }
    const operation = async () => {
      calls.push('operation')
      return value
    }
    const window = createWindow(
      async () => {
        calls.push('ownership')
      },
      {
        waitForIdle: async () => {
          calls.push('idle')
          return idle
        },
        monitorWindow: async (received, options) => {
          calls.push('monitor')
          assert.equal(received, operation)
          assert.deepEqual(options, { sampleMilliseconds: expected }, label)
          return { value: await received(), gpu }
        },
      },
      settings,
    )
    const run = {}
    assert.equal(await window(run, label, operation), value)
    assert.deepEqual(calls, ['ownership', 'idle', 'monitor', 'operation'])
    assert.deepEqual(run.gpuWindows, [{ label, idle, window: gpu }])
    assert.deepEqual(run.gpuIdle, { qualified: true })
  }
})
