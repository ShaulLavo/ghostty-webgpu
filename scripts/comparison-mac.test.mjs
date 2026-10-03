import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMacHostGate,
  macCpuAccounting,
  macHostSettings,
  sampleMacHost,
} from './comparison-mac.mjs'
import { GpuQualificationError } from './comparison-gpu.mjs'

const settings = {
  macIdleLoadAverage: 4,
  gpuSampleMilliseconds: 10,
  gpuIdleConsecutiveSamples: 2,
  gpuIdleWaitMilliseconds: 100,
  gpuCommandTimeoutMilliseconds: 20,
}
const reading = (changes = {}) => ({ acPower: true, t3Code: false, loadAverage: 0.5, ...changes })
function clock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds
    },
  }
}

test('Mac startup wait extends only admission time and gives up at five minutes', async () => {
  const timing = clock()
  const configured = macHostSettings({ ...settings, gpuSampleMilliseconds: 10_000 })
  assert.equal(settings.gpuIdleWaitMilliseconds, 100)
  assert.equal(configured.gpuIdleWaitMilliseconds, 300_000)
  assert.equal(configured.macIdleLoadAverage, settings.macIdleLoadAverage)
  assert.equal(configured.gpuIdleConsecutiveSamples, settings.gpuIdleConsecutiveSamples)
  const gate = createMacHostGate(configured, {
    ...timing,
    sample: async () => reading({ loadAverage: timing.now() < 70_000 ? 7 : 3 }),
  })
  const result = await gate.waitForIdle()
  assert.equal(result.waitMilliseconds, 80_000)
  assert.equal(result.qualified, true)
  const busy = createMacHostGate(configured, {
    ...clock(),
    sample: async () => reading({ loadAverage: 4 }),
  })
  await assert.rejects(busy.waitForIdle(), (error) => {
    assert.equal(error.evidence.waitMilliseconds, 300_000)
    assert.equal(error.evidence.qualified, false)
    return /idle wait expired/.test(error.message)
  })
})

test('Darwin clockrate supplies a labeled conservative bound without claiming CDP precision', () => {
  const observed =
    'kern.clockrate: { hz = 100, tick = 10000, tickadj = 0, profhz = 100, stathz = 100 }'
  const accounting = macCpuAccounting(observed)
  assert.equal(accounting.tickSeconds, 0.01)
  assert.equal(accounting.source.hz, 100)
  assert.equal(accounting.source.microsecondsPerTick, 10000)
  assert.equal(accounting.source.observed, observed)
  assert.match(accounting.source.kind, /conservative/)
  assert.match(accounting.source.scope, /CDP counter resolution is unmeasured/)
  assert.throws(() => macCpuAccounting('kern.clockrate: unavailable'))
  assert.throws(() => macCpuAccounting('{ hz = 100, tick = 0 }'))
})

test('Mac sampling records power, T3 presence and host load with bounded commands', async () => {
  for (const process of [
    '/Applications/T3 Code.app/Contents/MacOS/T3 Code',
    '/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)',
    '/Applications/T3 Code.app/Contents/Frameworks/T3 Code Helper.app/Contents/MacOS/T3 Code Helper',
  ]) {
    const commands = []
    const result = await sampleMacHost({
      timeoutMilliseconds: 20,
      load: () => [1.2, 2, 3],
      command: async (binary, args, options) => {
        commands.push({ binary, args })
        assert.equal(options.timeout, 20)
        assert.equal(options.killSignal, 'SIGKILL')
        return { stdout: binary.endsWith('pmset') ? "Now drawing from 'AC Power'" : process }
      },
    })
    assert.deepEqual(commands, [
      { binary: '/usr/bin/pmset', args: ['-g', 'batt'] },
      { binary: '/bin/ps', args: ['-axo', 'comm='] },
    ])
    assert.equal(result.acPower, true)
    assert.equal(result.t3Code, true)
    assert.equal(result.loadAverage, 1.2)
  }
})

test('battery and unrelated process names are parsed without false positives', async () => {
  const result = await sampleMacHost({
    timeoutMilliseconds: 20,
    load: () => [0, 0, 0],
    command: async (binary) => ({
      stdout: binary.endsWith('pmset')
        ? "Now drawing from 'Battery Power'"
        : '/tmp/T3 Code Benchmark\n/usr/bin/ps',
    }),
  })
  assert.equal(result.acPower, false)
  assert.equal(result.t3Code, false)
})

test('Mac idle requires consecutive low-load readings and retains the proxy limitation', async () => {
  const samples = [reading(), reading({ loadAverage: 4 }), reading(), reading()]
  const gate = createMacHostGate(settings, { ...clock(), sample: async () => samples.shift() })
  const result = await gate.waitForIdle()
  assert.equal(result.qualified, true)
  assert.equal(result.status, 'qualified')
  assert.equal(result.samples.length, 4)
  assert.equal(result.waitMilliseconds, 30)
  assert.match(result.limitation, /does not measure Metal GPU utilization/)
})

test('Mac idle gives up on sustained load and sampling failure', async () => {
  const busy = createMacHostGate(settings, {
    ...clock(),
    sample: async () => reading({ loadAverage: 5 }),
  })
  await assert.rejects(busy.waitForIdle(), (error) => {
    assert(error instanceof GpuQualificationError)
    assert.equal(error.evidence.qualified, false)
    assert.equal(error.evidence.waitMilliseconds, 100)
    return /idle wait expired/.test(error.message)
  })
  const broken = createMacHostGate(settings, {
    ...clock(),
    sample: async () => {
      throw Object.assign(new Error('probe failed'), { code: 'ENOENT' })
    },
  })
  await assert.rejects(broken.waitForIdle(), (error) => {
    assert.equal(error.evidence.samplingError.code, 'ENOENT')
    return /sampling failed/.test(error.message)
  })
})

for (const [sample, message] of [
  [reading({ acPower: false }), /AC power/],
  [reading({ t3Code: true }), /Close T3 Code/],
]) {
  test(`Mac power and T3 gates fail before the operation ${message}`, async () => {
    const gate = createMacHostGate(settings, { ...clock(), sample: async () => sample })
    await assert.rejects(gate.waitForIdle(), message)
    let called = false
    await assert.rejects(
      gate.monitorWindow(async () => {
        called = true
      }),
      message,
    )
    assert.equal(called, false)
  })
}

test('Mac window checks exclude benchmark load but reject AC loss at completion', async () => {
  const gate = createMacHostGate(settings, { sample: async () => reading({ loadAverage: 20 }) })
  const result = await gate.monitorWindow(async () => 42)
  assert.equal(result.value, 42)
  assert.equal(result.gpu.qualified, true)
  assert.equal(result.gpu.samples.length, 2)
  let samples = 0
  const losingPower = createMacHostGate(settings, {
    sample: async () => reading({ acPower: samples++ === 0 }),
  })
  await assert.rejects(
    losingPower.monitorWindow(async () => 42),
    /AC power/,
  )
})

test('Mac window retains mid-operation T3 and sampling failures and drains the monitor', async () => {
  for (const failure of [reading({ t3Code: true }), new Error('probe failure')]) {
    let samples = 0
    const gate = createMacHostGate(settings, {
      sample: async () => {
        if (samples++ === 0) return reading()
        if (failure instanceof Error) throw failure
        return failure
      },
    })
    await assert.rejects(
      gate.monitorWindow(() => new Promise((resolve) => setTimeout(resolve, 35))),
      GpuQualificationError,
    )
    assert.equal(samples, 2)
  }
})

test('Mac window propagates operation errors and validates limits', async () => {
  const gate = createMacHostGate(settings, { sample: async () => reading() })
  const failure = new Error('operation failed')
  await assert.rejects(
    gate.monitorWindow(async () => {
      throw failure
    }),
    (error) => error === failure,
  )
  assert.throws(() => createMacHostGate({ ...settings, macIdleLoadAverage: 0 }))
  await assert.rejects(gate.monitorWindow(async () => 42, { sampleMilliseconds: 0 }))
})
