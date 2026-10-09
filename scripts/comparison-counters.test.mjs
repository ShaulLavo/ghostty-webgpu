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

test('Mac cluster counts, IPC and instruction shares describe placement per process and channel', () => {
  const sample = delta(
    macSnapshot(),
    macSnapshot({
      ri_instructions: '9007199254740993400',
      ri_cycles: '9007199254740993250',
      ri_pinstructions: '400',
      ri_pcycles: '200',
    }),
  )
  for (const row of [sample.processes[0], sample.channels.renderer, sample.channels.allChrome]) {
    assert.equal(row.eInstructions, 100)
    assert.equal(row.eCycles, 150)
    assert.equal(row.ipc, 1.6)
    assert.equal(row.pIPC, 3)
    assert.equal(row.eIPC, 2 / 3)
    assert.equal(row.pInstructionShare, 0.75)
    assert.equal(row.pCycleShare, 0.4)
  }
})

test('cluster IPC uses summed counts, including both renderer and GPU processes', () => {
  const first = macSnapshot()
  first.processes[2] = structuredClone(first.processes[1])
  const last = macSnapshot({
    ri_instructions: '9007199254740993200',
    ri_cycles: '9007199254740993200',
    ri_pinstructions: '200',
    ri_pcycles: '150',
  })
  last.processes[2] = structuredClone(last.processes[1])
  last.processes[2].values.ri_instructions = '9007199254740993800'
  last.processes[2].values.ri_cycles = '9007199254740993250'
  last.processes[2].values.ri_pinstructions = '900'
  last.processes[2].values.ri_pcycles = '300'
  const processInfo = [
    { id: 1, type: 'renderer' },
    { id: 2, type: 'GPU' },
  ]
  const sample = counterDelta(
    parseCounterSnapshot(first, metadata),
    parseCounterSnapshot(last, metadata),
    processInfo,
    processInfo,
  )
  assert.equal(sample.channels.renderer.pIPC, 2)
  assert.equal(sample.channels.GPU.pIPC, 4)
  assert.equal(sample.channels.rendererPlusGPU.pIPC, 900 / 250)
  assert.equal(sample.channels.allChrome.eIPC, 100 / 200)
  assert.equal(sample.channels.allChrome.pInstructionShare, 0.9)
  assert.equal(sample.channels.allChrome.pCycleShare, 250 / 450)
})

test('cluster counts remain unavailable when the total or P-core capability is missing', () => {
  for (const missing of ['instructions', 'cycles', 'pInstructions', 'pCycles']) {
    const info = {
      ...metadata,
      capabilities: { ...metadata.capabilities, [missing]: { available: false } },
    }
    const sample = delta(macSnapshot(), macSnapshot(), info)
    assert.equal(sample.status, 'measured')
    for (const row of [sample.processes[0], sample.channels.allChrome]) {
      const count = missing.endsWith('Instructions') || missing === 'instructions'
      assert.equal(row[count ? 'eInstructions' : 'eCycles'], null)
      assert.equal(row.eIPC, null)
      assert.equal(row[count ? 'pInstructionShare' : 'pCycleShare'], null)
    }
  }
})

test('empty clusters have zero counts and no IPC estimate', () => {
  const zero = delta(macSnapshot(), macSnapshot())
  for (const row of [zero.processes[0], zero.channels.allChrome]) {
    assert.equal(row.eInstructions, 0)
    assert.equal(row.eCycles, 0)
    assert.equal(row.ipc, null)
    assert.equal(row.pIPC, null)
    assert.equal(row.eIPC, null)
    assert.equal(row.pInstructionShare, null)
    assert.equal(row.pCycleShare, null)
  }
  const onlyP = delta(
    macSnapshot(),
    macSnapshot({
      ri_instructions: '9007199254740993100',
      ri_cycles: '9007199254740993050',
      ri_pinstructions: '200',
      ri_pcycles: '150',
    }),
  )
  assert.equal(onlyP.channels.allChrome.eIPC, null)
  assert.equal(onlyP.channels.allChrome.pInstructionShare, 1)
  assert.equal(onlyP.channels.allChrome.pCycleShare, 1)
})

test('P-core counts above their total reject coverage without clamping', () => {
  for (const values of [{ ri_pinstructions: '101' }, { ri_pcycles: '101' }]) {
    const sample = delta(macSnapshot(), macSnapshot(values))
    assert.equal(sample.status, 'incomplete')
    assert.match(sample.coverage.errors[0].reason, /P-core .* exceeds total/)
    assert.equal(sample.channels.allChrome, undefined)
  }
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

test('Linux perf counters omit Mac-only ratios for full and asymmetric event coverage', () => {
  const fields = [
    'eInstructions',
    'eCycles',
    'ipc',
    'pIPC',
    'eIPC',
    'pInstructionShare',
    'pCycleShare',
  ]
  for (const [instructionShare, cycleShare] of [
    [1, 1],
    [1, 0.5],
    [0.5, 1],
  ]) {
    const last = linuxSnapshot(1e9, 1e9)
    const events = last.processes[1].values.pmus.cpu_core
    events.instructions[0].value = String(1e9 * instructionShare)
    events.instructions[0].runningNs = String(1e9 * instructionShare)
    events.cycles[0].value = String(2e9 * cycleShare)
    events.cycles[0].runningNs = String(1e9 * cycleShare)
    const sample = delta(linuxSnapshot(0, 0), last, { source: 'perf_event_open' })
    assert.equal(sample.status, 'measured')
    assert.equal(sample.channels.allChrome.instructions, 1e9 * instructionShare)
    assert.equal(sample.channels.allChrome.cycles, 2e9 * cycleShare)
    assert.equal(sample.processes[0].clockAvailable, cycleShare === 1)
    for (const row of sample.processes.concat(Object.values(sample.channels))) {
      assert.deepEqual(
        Object.keys(row).filter((field) => fields.includes(field)),
        [],
      )
    }
  }
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
  const processInfo = cpuBefore.concat([{ id: 2, type: 'renderer' }])
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
