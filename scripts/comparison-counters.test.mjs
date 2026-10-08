import { test } from 'node:test'
import assert from 'node:assert/strict'
import { counterDelta, parseCounterSnapshot } from './comparison-counters.mjs'
import { measureCpu } from './comparison-guards.mjs'

const cpuBefore = [{ id: 1, type: 'renderer', cpuTime: 2 }]
const cpuAfter = [{ id: 1, type: 'renderer', cpuTime: 3 }]
function macSnapshot(values = {}, identity = '42') {
  return {
    requestedNs: '1000',
    completedNs: '2000',
    processes: {
      1: {
        requestedNs: '1100',
        completedNs: '1900',
        values: {
          ri_proc_start_abstime: identity,
          ri_proc_exit_abstime: '0',
          ri_user_time: '1000000000',
          ri_system_time: '0',
          ri_user_ptime: '1000000000',
          ri_system_ptime: '0',
          ri_instructions: '9007199254740993000',
          ri_cycles: '9007199254740993000',
          ri_pinstructions: '100',
          ri_pcycles: '100',
          ri_energy_nj: '100',
          ri_penergy_nj: '100',
          ...values,
        },
      },
    },
  }
}
const metadata = {
  source: 'proc_pid_rusage/RUSAGE_INFO_V6',
  capabilities: Object.fromEntries(
    [
      'instructions',
      'cycles',
      'pCoreSeconds',
      'pInstructions',
      'pCycles',
      'energyJ',
      'pEnergyJ',
    ].map((name) => [name, { available: true }]),
  ),
}

function delta(before, after, info = metadata, final = cpuAfter) {
  return counterDelta(
    parseCounterSnapshot(before, info),
    parseCounterSnapshot(after, info),
    cpuBefore,
    final,
  )
}

test('native decimal strings subtract before converting to numbers and use ns and nJ', () => {
  const sample = delta(
    macSnapshot(),
    macSnapshot({
      ri_user_time: '2000000000',
      ri_user_ptime: '1750000000',
      ri_instructions: '9007199254740993100',
      ri_cycles: '9007199256740993000',
      ri_pinstructions: '175',
      ri_pcycles: '1500000100',
      ri_energy_nj: '500000100',
      ri_penergy_nj: '400000100',
    }),
  )
  assert.equal(sample.status, 'measured')
  assert.equal(sample.channels.allChrome.instructions, 100)
  assert.equal(sample.channels.renderer.cycles, 2e9)
  assert.equal(sample.channels.renderer.cpuSeconds, 1)
  assert.equal(sample.channels.renderer.pCoreShare, 0.75)
  assert.equal(sample.channels.renderer.effectiveClockGHz, 2)
  assert.equal(sample.channels.renderer.effectivePClockGHz, 2)
  assert.equal(sample.channels.renderer.energyJ, 0.5)
  assert.equal(sample.channels.renderer.pEnergyJ, 0.4)
})

test('PID reuse, disappeared processes and native errors leave aggregate coverage incomplete', () => {
  for (const after of [
    macSnapshot({}, '99'),
    { ...macSnapshot(), processes: {} },
    macSnapshot({ error: '3' }),
  ]) {
    const sample = delta(macSnapshot(), after)
    assert.equal(sample.status, 'incomplete')
    assert.equal(sample.channels.allChrome, undefined)
    assert(sample.coverage.errors.length > 0)
  }
  assert.equal(
    delta(macSnapshot(), macSnapshot(), metadata, [{ id: 2, type: 'renderer', cpuTime: 3 }]).status,
    'incomplete',
  )
  assert.equal(
    delta(macSnapshot(), macSnapshot({ ri_proc_exit_abstime: '50' })).status,
    'incomplete',
  )
})

test('counter regression, absent fields and invalid decimal input are explicit failures', () => {
  assert.equal(delta(macSnapshot(), macSnapshot({ ri_instructions: '1' })).status, 'incomplete')
  const missing = macSnapshot()
  delete missing.processes[1].values.ri_cycles
  assert.throws(() => parseCounterSnapshot(missing, metadata), /ri_cycles/)
  assert.throws(() => parseCounterSnapshot(macSnapshot({ ri_cycles: '1.5' }), metadata), /integer/)
})

test('P-core time may exceed total time only by nanosecond tick rounding', () => {
  const rounded = delta(
    macSnapshot(),
    macSnapshot({ ri_user_time: '1000366624', ri_user_ptime: '1000366627' }),
  )
  assert.notEqual(rounded.status, 'incomplete')
  assert.equal(rounded.channels.allChrome.pCoreSeconds, 0.000366627)
  const excess = delta(
    macSnapshot(),
    macSnapshot({ ri_user_time: '1000366624', ri_user_ptime: '1000366628' }),
  )
  assert.equal(excess.status, 'incomplete')
})

test('zero time has no inferred clock or P-core share', () => {
  const sample = delta(macSnapshot(), macSnapshot())
  assert.equal(sample.channels.allChrome.effectiveClockGHz, null)
  assert.equal(sample.channels.allChrome.pCoreShare, null)
})

function linuxSnapshot(amount, running) {
  const event = {
    tid: 1,
    value: String(amount),
    enabledNs: String(running),
    runningNs: String(running),
  }
  return {
    requestedNs: '1000',
    completedNs: '2000',
    processes: {
      1: {
        requestedNs: '1100',
        completedNs: '1900',
        values: {
          identity: '17',
          userTimeNs: String(running),
          systemTimeNs: '0',
          pmus: {
            cpu_core: { instructions: [event], cycles: [{ ...event, value: String(amount * 2) }] },
            cpu_atom: {
              instructions: [{ ...event, value: '0', runningNs: '0' }],
              cycles: [{ ...event, value: '0', runningNs: '0' }],
            },
          },
        },
      },
    },
  }
}

test('hybrid perf counters sum P and E PMUs without scaling or pretending to measure energy', () => {
  const sample = delta(linuxSnapshot(1, 1), linuxSnapshot(101, 1000000001), {
    source: 'perf_event_open',
    cpuTickNs: 10000000,
  })
  assert.equal(sample.channels.allChrome.instructions, 100)
  assert.equal(sample.channels.allChrome.cycles, 200)
  assert.equal(sample.channels.allChrome.pCoreShare, null)
  assert.equal(sample.channels.allChrome.energyJ, null)
  assert.equal(sample.channels.allChrome.effectivePClockGHz, null)
  assert.equal(sample.processes[0].pmus.cpu_core.instructions, 100)
  assert.equal(sample.processes[0].pmus.cpu_atom.instructions, 0)
  assert.equal(sample.scope, 'user-space only')
  assert.equal(sample.cpuTickNs, 10000000)
})

test('CPU seconds and their acquisition brackets keep the existing arithmetic with optional counters', async () => {
  let time = 0
  const session = {
    async send() {
      time += 10
      const processInfo = [{ id: 1, type: 'renderer', cpuTime: time / 1000 }]
      time += 10
      return { processInfo }
    },
  }
  let index = 0
  let closed = false
  const collector = {
    metadata,
    initialProcessInfo: cpuBefore,
    async snapshot() {
      index++
      return macSnapshot({ ri_user_time: String(index * 1000000000) })
    },
    async close() {
      closed = true
    },
  }
  const result = await measureCpu(
    session,
    async () => {
      time += 100
    },
    { now: () => time, counterReader: collector },
  )
  assert.equal(result.cpu.percentOfOneCore, 100)
  assert.equal(result.cpu.milliseconds, 120)
  assert.equal(result.cpu.acquisitionUncertaintyMilliseconds, 20)
  assert.equal(result.cpu.workCounters.status, 'measured')
  assert.deepEqual(result.cpu.interval, {
    before: { requested: 0, completed: 20 },
    after: { requested: 120, completed: 140 },
  })
  assert.equal(closed, true)
})

test('failed optional reader does not suppress an operation or alter CPU guards', async () => {
  let index = 0
  let ran = false
  const session = {
    async send() {
      return { processInfo: [{ id: 1, type: 'renderer', cpuTime: index++ }] }
    },
  }
  const counterReader = {
    metadata,
    async snapshot() {
      assert.fail('reader absent')
    },
    async close() {},
  }
  const result = await measureCpu(
    session,
    async () => {
      ran = true
    },
    { counterReader },
  )
  assert.equal(ran, true)
  assert.equal(result.cpu.secondsByType.renderer, 1)
  assert.equal(result.cpu.workCounters.status, 'skipped')
  assert.match(result.cpu.workCounters.reason, /reader absent/)
})

test('snapshot timestamps enclose every native process read', () => {
  const raw = macSnapshot()
  raw.processes[1].completedNs = '2001'
  assert.throws(() => parseCounterSnapshot(raw, metadata), /enclose/)
})

test('aggregate counter overflow is rejected before emitting rounded values', () => {
  const first = macSnapshot({ ri_instructions: '0' })
  const last = macSnapshot({ ri_instructions: String(Number.MAX_SAFE_INTEGER) })
  first.processes[2] = first.processes[1]
  last.processes[2] = last.processes[1]
  const processInfo = [...cpuBefore, { id: 2, type: 'renderer' }]
  assert.throws(
    () =>
      counterDelta(
        parseCounterSnapshot(first, metadata),
        parseCounterSnapshot(last, metadata),
        processInfo,
        processInfo,
      ),
    /exact numeric range/,
  )
})

test('malformed optional counters retain raw evidence and acquisition boundaries', async () => {
  let index = 0
  const session = {
    async send() {
      return { processInfo: [{ id: 1, type: 'renderer', cpuTime: index++ }] }
    },
  }
  const raw = macSnapshot({ ri_cycles: 'invalid' })
  const counterReader = {
    metadata,
    async snapshot() {
      return raw
    },
    async close() {},
  }
  const result = await measureCpu(session, async () => {}, { counterReader })
  assert.equal(result.cpu.workCounters.status, 'skipped')
  assert.deepEqual(result.cpu.workCounters.snapshots, { before: raw, after: raw })
  assert(
    result.cpu.workCounters.boundary.before.native.completed >=
      result.cpu.workCounters.boundary.before.native.requested,
  )
  assert.equal(result.cpu.secondsByType.renderer, 1)
})
