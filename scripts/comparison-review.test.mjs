import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { tracePhase } from './comparison-trace.mjs'
import { readFile, mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { measureCpu } from './comparison-guards.mjs'
import { counterDelta, parseCounterSnapshot } from './comparison-counters.mjs'
import { compactEvidence } from './comparison-compact.mjs'
import { markdown, summaries } from './comparison-report.mjs'
import { measurementCases } from './comparison-options.mjs'
import { presentationResult } from './comparison-latency.mjs'

const golden = JSON.parse(
  await readFile(new URL('./fixtures/comparison-opt-out-golden.json', import.meta.url)),
)
const source = await readFile(new URL('./comparison-runner.mjs', import.meta.url), 'utf8')
const capabilityNames = [
  'instructions',
  'cycles',
  'pCoreSeconds',
  'pInstructions',
  'pCycles',
  'energyJ',
  'pEnergyJ',
]
const metadata = {
  source: 'proc_pid_rusage/RUSAGE_INFO_V6',
  capabilities: Object.fromEntries(capabilityNames.map((name) => [name, { available: true }])),
}
function snapshot(amount = 0, pids = [1]) {
  return {
    requestedNs: String(amount * 1000 + 1),
    completedNs: String(amount * 1000 + 100),
    processes: Object.fromEntries(
      pids.map((pid) => [
        pid,
        {
          requestedNs: String(amount * 1000 + 2),
          completedNs: String(amount * 1000 + 90),
          values: {
            ri_proc_start_abstime: String(pid),
            ri_proc_exit_abstime: '0',
            ri_user_time: String(amount * 1000000000),
            ri_system_time: '0',
            ri_user_ptime: String(amount * 1000000000),
            ri_system_ptime: '0',
            ri_instructions: String(amount * 100),
            ri_cycles: String(amount * 200),
            ri_pinstructions: String(amount * 100),
            ri_pcycles: String(amount * 200),
            ri_energy_nj: String(amount * 1000000),
            ri_penergy_nj: String(amount * 1000000),
          },
        },
      ]),
    ),
  }
}

function createArtifact(tracing) {
  const context = {
    ...golden.context,
    tracing,
    cpuOptions: { processCounters: false },
    randomUUID: () => 'fixed-session',
    measurementCases,
    Date: class extends Date {
      constructor() {
        super('2026-10-08T00:00:00.000Z')
      }
    },
  }
  const start = source.indexOf('const artifact = {')
  const end = source.indexOf('\nconst artifactPath', start)
  return new Function(...Object.keys(context), `${source.slice(start, end)}; return artifact`)(
    ...Object.values(context),
  )
}

test('review 1: opt-out CPU samples are byte-identical to the pinned base golden', async () => {
  let clock = 0
  const session = {
    async send() {
      return { processInfo: [{ id: 1, type: 'renderer', cpuTime: 1 + clock / 1000 }] }
    },
  }
  const actual = await measureCpu(
    session,
    async () => {
      clock += 100
      return 'complete'
    },
    { now: () => clock, tickSeconds: 0.01 },
  )
  assert.equal(JSON.stringify(actual), JSON.stringify(golden.cpu))
})

for (const expected of golden.artifacts) {
  test(`review 1: opt-out ${expected.tracing ? 'trace' : 'normal'} artifact, compact, summaries and Markdown match golden bytes`, async () => {
    assert.equal(JSON.stringify(createArtifact(expected.tracing)), expected.runner)
    assert.equal(JSON.stringify(await compactEvidence(expected.artifact)), expected.compact)
    assert.equal(JSON.stringify(summaries(expected.artifact)), JSON.stringify(expected.summaries))
    assert.equal(markdown(expected.artifact), expected.markdown)
  })
}

for (const fails of [false, true]) {
  test(`review 2: ${fails ? 'timed-out' : 'delayed'} native acquisition stays outside the unchanged CPU bracket`, async () => {
    let clock = 0
    let cpu = 0
    let reads = 0
    const session = {
      async send() {
        return { processInfo: [{ id: 1, type: 'renderer', cpuTime: cpu }] }
      },
    }
    const counterReader = {
      metadata,
      async snapshot() {
        reads++
        clock += reads === 1 ? 2000 : 50
        cpu += reads === 1 ? 0.4 : 0.2
        if (fails) assert.fail('Native reader timed out')
        return snapshot(reads - 1)
      },
      async close() {},
    }
    const actual = await measureCpu(
      session,
      async () => {
        clock += 100
        cpu += 0.1
      },
      { counterReader, now: () => clock },
    )
    assert.equal(actual.cpu.milliseconds, 100)
    assert(Math.abs(actual.cpu.percentOfOneCore - 100) < 1e-9)
    assert.equal(actual.cpu.acquisitionUncertaintyMilliseconds, 0)
    assert.deepEqual(actual.cpu.workCounters.boundary.before.native, {
      requested: 0,
      completed: 2000,
    })
    if (fails) assert.equal(actual.cpu.workCounters.snapshots.before, null)
  })
}

test('review 6: successful recorded presentation retains registered CPU and work evidence', async () => {
  const recorded = JSON.parse(
    await readFile(new URL('./fixtures/comparison-presentation.json', import.meta.url)),
  )
  const cpu = {
    ...golden.cpu.cpu,
    workCounters: {
      status: 'measured',
      channels: {},
      snapshots: { before: snapshot(), after: snapshot(1) },
      coverage: { matched: [1], errors: [] },
    },
  }
  const phase = { ...recorded.phase, trace: 'success.trace.json.gz', cpu }
  const result = presentationResult({}, phase, recorded.events)
  assert.deepEqual(result.cpu, cpu)
  const artifact = structuredClone(golden.artifacts[0].artifact)
  artifact.processCounters = true
  artifact.runs[0].latency = result
  const compact = await compactEvidence(artifact)
  assert.deepEqual(compact.runs[0].latency.cpu.workCounters.coverage, cpu.workCounters.coverage)
  assert.equal(compact.runs[0].latency.cpu.workCounters.snapshots, undefined)
})

test('review 7: CPU churn remains rejected with stable deltas, raw snapshots and failed brackets retained', async () => {
  let ran = false
  let reads = 0
  let closed = false
  const counterReader = {
    metadata,
    async snapshot() {
      return snapshot(reads++, ran ? [1] : [1, 2])
    },
    async close() {
      closed = true
    },
  }
  const session = {
    async send() {
      return {
        processInfo: (ran ? [1] : [1, 2]).map((id) => ({
          id,
          type: 'renderer',
          cpuTime: ran ? 1 : 0,
        })),
      }
    },
  }
  await assert.rejects(
    () =>
      measureCpu(
        session,
        async () => {
          ran = true
        },
        { counterReader },
      ),
    (error) => {
      assert.match(error.message, /CPU process set changed/)
      assert.equal(error.cpuFailure.workCounters.status, 'incomplete')
      assert.equal(error.cpuFailure.workCounters.processes[0].pid, 1)
      assert.equal(error.cpuFailure.workCounters.processes[0].instructions, 100)
      assert.equal(
        error.cpuFailure.workCounters.snapshots.before.processes[2].values.ri_proc_start_abstime,
        '2',
      )
      assert.equal(error.cpuFailure.workCounters.coverage.errors[0].pid, 2)
      assert(
        error.cpuFailure.workCounters.boundary.after.native.completed >=
          error.cpuFailure.workCounters.boundary.after.native.requested,
      )
      return true
    },
  )
  assert.equal(closed, true)
})

test('review 8: compact trace and control phases retain registered counters and omit raw snapshots', async () => {
  const artifact = structuredClone(golden.artifacts[1].artifact)
  artifact.processCounters = true
  for (const phase of artifact.runs[0].phases)
    phase.cpu.workCounters = {
      status: 'measured',
      source: metadata.source,
      processes: [{ pid: 1, identity: '1' }],
      channels: { allChrome: { instructions: 100 } },
      coverage: { matched: [1], errors: [] },
      boundary: { before: { native: { requested: 1, completed: 2 } } },
      snapshots: { before: snapshot(), after: snapshot(1) },
    }
  const compact = await compactEvidence(artifact)
  assert.equal(compact.runs[0].phases.length, 2)
  for (const phase of compact.runs[0].phases) {
    assert(phase.label)
    assert.equal(phase.cpu.workCounters.processes[0].identity, '1')
    assert.equal(phase.cpu.workCounters.channels.allChrome.instructions, 100)
    assert.deepEqual(phase.cpu.workCounters.coverage, { matched: [1], errors: [] })
    assert.equal(phase.cpu.workCounters.boundary.before.native.completed, 2)
    assert.equal(phase.cpu.workCounters.snapshots, undefined)
  }
})

function perfSnapshot(amount, running) {
  const event = {
    tid: 1,
    value: String(amount),
    enabledNs: String(amount ? 1000000000 : 0),
    runningNs: String(running),
  }
  return {
    requestedNs: '1',
    completedNs: '100',
    processes: {
      1: {
        requestedNs: '2',
        completedNs: '90',
        values: {
          identity: '1',
          userTimeNs: String(amount ? 1000000000 : 0),
          systemTimeNs: '0',
          pmus: {
            cpu_core: { instructions: [event], cycles: [event] },
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

test('review 4: active user CPU with unscheduled events is unavailable, while another hybrid PMU may have zero residency', () => {
  const meta = { source: 'perf_event_open' }
  const before = perfSnapshot(0, 0)
  const unscheduled = perfSnapshot(1, 0)
  for (const events of Object.values(unscheduled.processes[1].values.pmus)) {
    events.instructions[0].value = '0'
    events.cycles[0].value = '0'
  }
  const info = [{ id: 1, type: 'renderer' }]
  const result = counterDelta(
    parseCounterSnapshot(before, meta),
    parseCounterSnapshot(unscheduled, meta),
    info,
    info,
  )
  assert.equal(result.status, 'incomplete')
  assert.deepEqual(result.channels, {})
  assert.match(result.coverage.errors[0].reason, /schedul/)
  const live = counterDelta(
    parseCounterSnapshot(before, meta),
    parseCounterSnapshot(perfSnapshot(100, 1000000000), meta),
    info,
    info,
  )
  assert.equal(live.status, 'measured')
  assert.equal(live.channels.allChrome.instructions, 100)
})

test('review 5: successful Mac rusage with unsupported channels retains CPU and reports unavailable work and energy', () => {
  const meta = {
    ...metadata,
    capabilities: Object.fromEntries(
      capabilityNames.map((name) => [
        name,
        { available: false, reason: 'Calibration could not establish native channel support' },
      ]),
    ),
  }
  const before = snapshot()
  const after = snapshot(1)
  for (const key of [
    'ri_instructions',
    'ri_cycles',
    'ri_pinstructions',
    'ri_pcycles',
    'ri_user_ptime',
    'ri_energy_nj',
    'ri_penergy_nj',
  ])
    after.processes[1].values[key] = '0'
  const info = [{ id: 1, type: 'renderer' }]
  const result = counterDelta(
    parseCounterSnapshot(before, meta),
    parseCounterSnapshot(after, meta),
    info,
    info,
  )
  assert.equal(result.channels.allChrome.cpuSeconds, 1)
  for (const key of ['instructions', 'cycles', 'effectiveClockGHz', 'pCoreShare', 'energyJ'])
    assert.equal(result.channels.allChrome[key], null)
  assert.match(result.unavailable.energyJ, /Calibration/)
})

test('review 9: reader startup works without import.meta.dirname on the Node 20.0 module surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-node20-surface-'))
  try {
    const text = await readFile(new URL('./comparison-counters.mjs', import.meta.url), 'utf8')
    await writeFile(
      join(directory, 'comparison-counters.mjs'),
      `delete import.meta.dirname;\n${text}`,
    )
    for (const name of ['comparison-rusage.py', 'comparison-perf.py'])
      await copyFile(new URL(`./${name}`, import.meta.url), join(directory, name))
    const module = await import(pathToFileURL(join(directory, 'comparison-counters.mjs')).href)
    const reader = await module.createCounterReader({
      async send() {
        return { processInfo: [{ id: process.pid }] }
      },
    })
    try {
      assert(reader.metadata || reader.skipped)
      assert.doesNotMatch(reader.reason ?? '', /ERR_INVALID_ARG_TYPE|path.*undefined/)
    } finally {
      await reader.close?.()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native energy and CPU milliseconds retain useful report precision', () => {
  const artifact = structuredClone(golden.artifacts[0].artifact)
  artifact.processCounters = true
  artifact.runs[0].output.cpu.workCounters = {
    status: 'measured',
    channels: { allChrome: { energyJ: 0.001234, cpuSeconds: 0.001234 } },
    limitations: [],
  }
  const text = markdown(artifact)
  assert.match(text, /0\.001234 J estimate/)
  assert.match(text, /0\.001234 native CPU s/)
})

test('multiplexed raw counters retain scheduling evidence and suppress full-CPU clock ratios', () => {
  const meta = { source: 'perf_event_open' }
  const info = [{ id: 1, type: 'renderer' }]
  const result = counterDelta(
    parseCounterSnapshot(perfSnapshot(0, 0), meta),
    parseCounterSnapshot(perfSnapshot(100, 500000000), meta),
    info,
    info,
  )
  assert.equal(result.channels.allChrome.cycles, 100)
  assert.equal(result.channels.allChrome.effectiveClockGHz, null)
  assert.match(result.channels.allChrome.clockReason, /multiplexing/)
  assert.equal(result.processes[0].pmus.cpu_core.cyclesCoverage[0].runningNs, 500000000)
})

test('native helper startup and attachment precede browser trace activation', async (context) => {
  if (!['linux', 'darwin'].includes(process.platform))
    return context.skip('Native counters require Linux or macOS')
  const python = spawnSync(process.platform === 'darwin' ? '/usr/bin/python3' : 'python3', [
    '--version',
  ])
  if (python.error?.code === 'ENOENT') return context.skip('Python 3 is unavailable')
  const root = await mkdtemp(join(tmpdir(), 'comparison-trace-startup-'))
  const calls = []
  let clock = 0
  const session = new EventEmitter()
  session.send = async (name) => {
    calls.push(name)
    if (name === 'SystemInfo.getProcessInfo')
      return { processInfo: [{ id: process.pid, type: 'renderer', cpuTime: clock / 1000 }] }
    if (name === 'Tracing.end') session.emit('Tracing.tracingComplete', { stream: 'trace' })
    if (name === 'IO.read') return { data: '{"traceEvents":[]}', eof: true }
    return {}
  }
  try {
    const result = await tracePhase({
      page: {
        async evaluate() {
          return { spans: [], counters: [], markers: [], ownership: [] }
        },
      },
      browserSession: session,
      output: root,
      label: 'startup',
      traced: true,
      cpuOptions: { processCounters: true },
      now: () => clock,
      async operation() {
        clock += 100
      },
    })
    assert(calls.indexOf('SystemInfo.getProcessInfo') < calls.indexOf('Tracing.start'))
    assert(result.cpu.workCounters.setup.completed >= result.cpu.workCounters.setup.requested)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const traced of [false, true]) {
  test(`review 7: ${traced ? 'traced' : 'control'} CPU rejection drains trace and retains structured phase evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'comparison-churn-evidence-'))
    let ran = false
    let reads = 0
    let clock = 0
    const calls = []
    const session = new EventEmitter()
    session.send = async (name) => {
      calls.push(name)
      if (name === 'SystemInfo.getProcessInfo')
        return {
          processInfo: (ran ? [1] : [1, 2]).map((id) => ({
            id,
            type: 'renderer',
            cpuTime: clock / 1000,
          })),
        }
      if (name === 'Tracing.end') session.emit('Tracing.tracingComplete', { stream: 'trace' })
      if (name === 'IO.read') return { data: '{"traceEvents":[]}', eof: true }
      return {}
    }
    const reader = {
      metadata,
      async snapshot() {
        return snapshot(reads++, ran ? [1] : [1, 2])
      },
      async close() {},
    }
    try {
      await assert.rejects(
        () =>
          tracePhase({
            page: {
              async evaluate() {
                return { spans: [], counters: [], markers: [], ownership: [] }
              },
            },
            browserSession: session,
            output: root,
            label: 'churn',
            traced,
            cpuOptions: { counterReader: reader },
            now: () => clock,
            async operation() {
              clock += 100
              ran = true
            },
          }),
        (error) => {
          assert.match(error.message, /CPU process set changed/)
          assert.equal(error.phaseFailure.label, 'churn')
          assert.equal(error.phaseFailure.cpu.workCounters.processes[0].instructions, 100)
          if (traced) assert.equal(error.phaseFailure.trace, 'churn.trace.json.gz')
          return true
        },
      )
      if (traced) {
        assert(calls.includes('IO.close'))
        assert((await readFile(join(root, 'churn.trace.json.gz'))).length > 0)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('registered trace and control work values appear in reports while omitted old phases remain omitted', () => {
  const artifact = structuredClone(golden.artifacts[1].artifact)
  artifact.processCounters = true
  for (const phase of artifact.runs[0].phases)
    phase.cpu.workCounters = { status: 'measured', channels: { allChrome: { instructions: 100 } } }
  const text = markdown(artifact)
  assert.match(text, /trace\/ascii-control\/work\/allChrome\/instructions \| 100 instructions/)
  assert.match(text, /trace\/ascii-trace\/work\/allChrome\/instructions \| 100 instructions/)
})

test('Mac metadata without established capabilities reports explicit unavailable reasons', () => {
  const info = [{ id: 1, type: 'renderer' }]
  const meta = { source: metadata.source }
  const result = counterDelta(
    parseCounterSnapshot(snapshot(), meta),
    parseCounterSnapshot(snapshot(1), meta),
    info,
    info,
  )
  assert.equal(result.channels.allChrome.cpuSeconds, 1)
  assert.equal(result.channels.allChrome.energyJ, null)
  assert.match(result.unavailable.energyJ, /did not establish support/)
})

test('idle unscheduled zero perf observations retain legitimate zero work without a clock ratio', () => {
  const info = [{ id: 1, type: 'renderer' }]
  const meta = { source: 'perf_event_open' }
  const result = counterDelta(
    parseCounterSnapshot(perfSnapshot(0, 0), meta),
    parseCounterSnapshot(perfSnapshot(0, 0), meta),
    info,
    info,
  )
  assert.equal(result.status, 'measured')
  assert.equal(result.channels.allChrome.instructions, 0)
  assert.equal(result.channels.allChrome.cycles, 0)
  assert.equal(result.channels.allChrome.effectiveClockGHz, null)
})
