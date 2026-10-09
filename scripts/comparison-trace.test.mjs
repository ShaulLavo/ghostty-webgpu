import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { measureCpu, withDeadline } from './comparison-guards.mjs'
import { refreshSampler } from '../bench/comparison-refresh.ts'
import {
  assertDisplay,
  discardTraceWindow,
  displaySummary,
  prepareOutput,
  summarizeRecords,
  tracePhase,
} from './comparison-trace.mjs'
import { EventEmitter } from 'node:events'

test('default coordinated frame work joins its own accepted commit without borrowing later counters', () => {
  const records = {
    spans: [
      { terminal: 0, operation: 'drawFrame', category: 'js', start: 10, end: 20, self: 2 },
      {
        terminal: 0,
        operation: 'encode',
        category: 'commands',
        start: 12,
        end: 18,
        self: 6,
        commands: [0],
      },
      {
        terminal: 0,
        operation: 'commit',
        category: 'js',
        start: 25,
        end: 26,
        self: 1,
        commands: [0],
      },
      {
        terminal: 0,
        operation: 'commit',
        category: 'js',
        start: 30,
        end: 31,
        self: 1,
        commands: [1],
      },
    ],
    counters: [
      { terminal: 0, operation: 'bufferBytes', time: 11, value: 256 },
      { terminal: 0, operation: 'frames', time: 25.5, value: 1 },
      { terminal: 0, operation: 'zigFrames', time: 25.5, value: 1 },
      { terminal: 0, operation: 'frames', time: 30.5, value: 1 },
    ],
    ownership: [{ terminal: 0, deviceOwner: 10, coordinator: 11 }],
  }
  const summary = summarizeRecords(records)
  assert.deepEqual(summary.frames[0].counts, { bufferBytes: 256, frames: 1, zigFrames: 1 })
  assert.equal(summary.byTerminal[0].frames, 2)
  assert.deepEqual(summary.ownership, { deviceOwner: 1, coordinator: 1 })
  records.spans[2].commands = [2]
  assert.deepEqual(summarizeRecords(records).frames[0].counts, { bufferBytes: 256 })
})

test('display qualification accepts skipped frames and requires a visible 60 Hz median', () => {
  const probe = displaySummary(Array(110).fill(16.67).concat(Array(9).fill(33.33), [150]), {
    visibility: 'visible',
    focus: true,
  })
  assert.equal(assertDisplay(probe), 16.67)
  assert.equal(probe.frameCount, 120)
  assert.equal(probe.p95, 33.33)
  assert.equal(probe.max, 150)
  assert.throws(() => assertDisplay({ ...probe, visibility: 'hidden' }), /Mac display unavailable/)
  for (const periods of [
    [],
    Array(20).fill(0),
    Array(20).fill(1000),
    Array(20).fill(33.33),
    Array(20).fill(14.9),
    Array(20).fill(18.5),
  ]) {
    assert.throws(
      () => assertDisplay(displaySummary(periods, { visibility: 'visible' })),
      /Mac display unavailable/,
    )
  }
})

test('mounted workload cadence is retained after idle display qualification', () => {
  const idle = displaySummary(Array(120).fill(16.67), { visibility: 'visible' })
  const mounted = displaySummary(Array(120).fill(33.33), { visibility: 'visible' })
  assert.equal(assertDisplay(idle), 16.67)
  assert.equal(assertDisplay(mounted, { idle: false }), 33.33)
  assert.throws(() => assertDisplay(mounted), /Mac display unavailable/)
})

test('category shares use exclusive spans and preserve per-terminal counts', () => {
  const result = summarizeRecords({
    spans: [
      { category: 'snapshot', self: 9 },
      { category: 'damage', self: 1 },
    ],
    counters: [
      { terminal: 0, operation: 'frames', value: 1 },
      { terminal: 0, operation: 'bufferBytes', value: 80 },
      { terminal: 0, operation: 'bufferBytes', value: 160 },
      { terminal: 1, operation: 'frames', value: 2 },
    ],
  })
  assert.deepEqual(result.milliseconds, { snapshot: 9, damage: 1 })
  assert.deepEqual(result.shares, { snapshot: 90, damage: 10 })
  assert.deepEqual(result.byTerminal, { 0: { frames: 1, bufferBytes: 240 }, 1: { frames: 2 } })
})

test('frame counts match each terminal interval and ownership uses object identities', () => {
  const result = summarizeRecords({
    spans: [
      { terminal: 0, operation: 'drawFrame', start: 10, end: 12, category: 'js', self: 1 },
      { terminal: 1, operation: 'drawFrame', start: 13, end: 15, category: 'js', self: 1 },
    ],
    counters: [
      { terminal: 0, time: 9, operation: 'bufferBytes', value: 500 },
      { terminal: 0, time: 11, operation: 'bufferBytes', value: 80 },
      { terminal: 1, time: 11, operation: 'bufferBytes', value: 90 },
      { terminal: 1, time: 14, operation: 'submissions', value: 1 },
    ],
    ownership: [
      { terminal: 0, scheduler: 0, device: 1, queue: 2, pipelines: [3, 4] },
      { terminal: 1, scheduler: 5, device: 1, queue: 2, pipelines: [3, 4] },
    ],
  })
  assert.deepEqual(
    result.frames.map((frame) => frame.counts),
    [{ bufferBytes: 80 }, { submissions: 1 }],
  )
  assert.deepEqual(result.ownership, { scheduler: 2, device: 1, queue: 1, pipelines: 2 })
})

test('failed display qualification discards current and completed cases in a fresh output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-cleanup-'))
  try {
    const output = join(root, 'window')
    await prepareOutput(output, { tracing: true })
    for (const name of [
      'finished.trace.json.gz',
      'current.trace.json.gz',
      'current.png',
      'comparison.json',
    ]) {
      await writeFile(join(output, name), 'owned')
    }
    await writeFile(join(output, 'qualification.json'), 'failed probe retained')
    await writeFile(join(root, 'previous-window.json'), 'retained')
    await assert.rejects(prepareOutput(output, { tracing: true }), { code: 'EEXIST' })
    await discardTraceWindow(output)
    assert.deepEqual(await readdir(output), ['qualification.json'])
    assert.equal(
      await readFile(join(output, 'qualification.json'), 'utf8'),
      'failed probe retained',
    )
    assert.equal(await readFile(join(root, 'previous-window.json'), 'utf8'), 'retained')
  } finally {
    await rm(root, { recursive: true })
  }
})

test('a CPU qualification failure stops recording and drains the Chrome trace stream', async () => {
  const calls = []
  const session = new EventEmitter()
  let samples = 0
  session.send = async (name) => {
    calls.push(name)
    if (name === 'SystemInfo.getProcessInfo') {
      samples++
      return { processInfo: [{ id: samples, type: 'renderer', cpuTime: 0 }] }
    }
    if (name === 'Tracing.end') session.emit('Tracing.tracingComplete', { stream: 'trace' })
    if (name === 'IO.read') return { data: '{"traceEvents":[]}', eof: true }
    return {}
  }
  const page = {
    evaluate: async (callback) => {
      calls.push(callback.toString().includes('traceBegin') ? 'record-begin' : 'record-end')
      return { spans: [], counters: [], markers: [], ownership: [] }
    },
  }
  await assert.rejects(
    tracePhase({
      page,
      browserSession: session,
      traced: true,
      operation: async () => ({}),
      label: 'failure',
      output: '/work/tmp/plan-283',
    }),
    /process/i,
  )
  assert(calls.includes('record-end'))
  assert(calls.includes('Tracing.end'))
  assert(calls.includes('IO.read'))
  assert(calls.includes('IO.close'))
})

test('mounted probes reject hidden pages, empty samples and probe errors', () => {
  for (const probe of [
    displaySummary([16.67], { visibility: 'hidden' }),
    displaySummary([], { visibility: 'visible' }),
    displaySummary(Array(120).fill(33.33), { visibility: 'visible', error: 'timeout' }),
    { ...displaySummary(Array(120).fill(16.67), { visibility: 'visible' }), periods: [NaN] },
  ])
    assert.throws(() => assertDisplay(probe, { idle: false }))
})

test('ordinary qualification accepts healthy high refresh and keeps mounted stretching', () => {
  for (const period of [1000 / 120, 1000 / 144]) {
    const idle = displaySummary(Array(120).fill(period), { visibility: 'visible' })
    assert.equal(assertDisplay(idle, { expectedPeriod: null }), period)
    assert.equal(
      assertDisplay(
        displaySummary(Array(120).fill(3 * period), {
          visibility: 'visible',
        }),
        { idle: false, expectedPeriod: period },
      ),
      3 * period,
    )
  }
})

test('ordinary output permits reruns while trace output owns a fresh directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gw-rerun-'))
  try {
    const output = join(root, 'ordinary')
    await prepareOutput(output, { tracing: false })
    await writeFile(join(output, 'previous'), 'retained')
    await prepareOutput(output, { tracing: false })
    assert.equal(await readFile(join(output, 'previous'), 'utf8'), 'retained')
    await assert.rejects(prepareOutput(output, { tracing: true }), { code: 'EEXIST' })
  } finally {
    await rm(root, { recursive: true })
  }
})

test('expired refresh callbacks cannot append to or mark a later probe', async () => {
  const callbacks = new Map()
  const cancelled = []
  let id = 0
  const sampler = refreshSampler(
    (tick) => {
      callbacks.set(++id, tick)
      return id
    },
    (value) => cancelled.push(value),
  )
  const first = sampler.start(2)
  callbacks.get(1)(0)
  const stale = callbacks.get(2)
  assert.deepEqual(sampler.cancel(), [])
  assert.deepEqual(await first, [])
  const second = sampler.start(1)
  stale(16)
  callbacks.get(3)(100)
  callbacks.get(4)(108)
  assert.deepEqual(await second, [8])
  assert.deepEqual(cancelled, [2])
})

test('CPU interval excludes recorder activation and matches snapshot acquisition times', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gw-cpu-'))
  let time = 0
  const session = new EventEmitter()
  session.send = async (name) => {
    if (name === 'SystemInfo.getProcessInfo')
      return {
        processInfo: [{ id: 1, type: 'renderer', cpuTime: time / 1000 }],
      }
    if (name === 'Tracing.end') session.emit('Tracing.tracingComplete', { stream: 'trace' })
    if (name === 'IO.read') return { data: '{"traceEvents":[]}', eof: true }
    return {}
  }
  const page = {
    evaluate: async (fn) => {
      if (fn.toString().includes('traceBegin')) time += 100
      return { spans: [], counters: [], markers: [], ownership: [] }
    },
  }
  try {
    const result = await tracePhase({
      page,
      browserSession: session,
      output: root,
      label: 'cpu',
      traced: true,
      now: () => time,
      operation: async () => {
        time += 100
        return {}
      },
    })
    assert.equal(result.cpu.percentOfOneCore, 100)
    assert.equal(result.cpu.milliseconds, 100)
    assert.equal(result.milliseconds, 100)
  } finally {
    await rm(root, { recursive: true })
  }
})

test('a deadline awaits delayed browser-wide trace cleanup before rejection', async () => {
  const calls = []
  let finish
  const cleanup = new Promise((resolve) => {
    finish = resolve
  })
  let expire
  const expired = new Promise((resolve) => {
    expire = resolve
  })
  const running = withDeadline(
    async () => {
      await expired
      calls.push('Tracing.end')
      await cleanup
      calls.push('trace drained')
    },
    1,
    async () => {
      expire()
    },
    { drain: true },
  )
  let settled = false
  running.catch(() => {
    settled = true
  })
  await expired
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  finish()
  await assert.rejects(running, /deadline/)
  assert.deepEqual(calls, ['Tracing.end', 'trace drained'])
})

test('CPU denominator brackets asynchronous snapshot acquisition rather than operation duration', async () => {
  let time = 0
  const session = {
    async send() {
      time += 10
      const processInfo = [{ id: 1, type: 'renderer', cpuTime: time / 1000 }]
      time += 10
      return { processInfo }
    },
  }
  const result = await measureCpu(
    session,
    async () => {
      time += 100
    },
    { now: () => time },
  )
  assert.equal(result.milliseconds, 100)
  assert.equal(result.cpu.milliseconds, 120)
  assert.equal(result.cpu.acquisitionUncertaintyMilliseconds, 20)
  assert.equal(result.cpu.percentOfOneCore, 100)
  assert.deepEqual(result.cpu.interval, {
    before: { requested: 0, completed: 20 },
    after: { requested: 120, completed: 140 },
  })
})

test('a stalled trace drain terminates the window deadline instead of hanging', async () => {
  await assert.rejects(
    withDeadline(
      () => new Promise(() => {}),
      1,
      () => {},
      { drain: true, drainMilliseconds: 5 },
    ),
    /deadline exceeded/,
  )
})

test('mounted probe metadata must match real finite samples', () => {
  const valid = displaySummary(Array(120).fill(16.67), { visibility: 'visible' })
  assert.throws(() => assertDisplay({ ...valid, periods: [] }, { idle: false }))
  assert.throws(() => assertDisplay({ ...valid, median: NaN }, { idle: false }))
})
