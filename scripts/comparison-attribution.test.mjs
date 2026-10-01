import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactAnalysis,
  validateArtifact,
  frameCadence,
  mainThread,
  sampledProfile,
  timelines,
  unionMilliseconds,
} from './comparison-attribution.mjs'

test('compact evidence preserves terminal frame distributions and hashes raw intervals', () => {
  const result = compactAnalysis({
    qualifications: [{ median: 16.67, periods: [16.67] }],
    rows: [
      {
        cpu: { before: [], after: [], percentOfOneCore: 40 },
        summary: {
          ownership: { scheduler: 2 },
          frames: [
            { terminal: 0, counts: { draws: 2 } },
            { terminal: 0, counts: { draws: 2 } },
            { terminal: 1, counts: { draws: 2 } },
          ],
        },
      },
    ],
  })
  assert.equal(result.qualifications[0].periods, undefined)
  assert.match(result.qualifications[0].periodsSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.rows[0].cpu, { percentOfOneCore: 40 })
  assert.deepEqual(result.rows[0].summary.frameCounterDistribution, [
    { terminal: 0, counts: { draws: 2 }, samples: 2 },
    { terminal: 1, counts: { draws: 2 }, samples: 1 },
  ])
})

test('main task denominator clips the window and unions nested tasks', () => {
  assert.equal(
    unionMilliseconds([
      [0, 10],
      [2, 8],
      [9, 15],
      [20, 25],
    ]),
    20,
  )
  const events = [
    { name: 'compare/begin', ts: 200000, pid: 1, tid: 2, args: { data: { startTime: 100 } } },
    { name: 'RunTask', ph: 'X', ts: 180000, dur: 120000, pid: 1, tid: 2 },
    { name: 'RunTask', ph: 'X', ts: 220000, dur: 20000, pid: 1, tid: 2 },
    { name: 'RunTask', ph: 'X', ts: 200000, dur: 100000, pid: 3, tid: 4 },
  ]
  const records = {
    markers: [
      { operation: 'begin', time: 100 },
      { operation: 'end', time: 150 },
    ],
  }
  const result = mainThread(events, records)
  assert.equal(result.offset, 100)
  assert.equal(result.taskMilliseconds, 50)
})

test('CPU samples join profile identity across sampler threads and clip the recording window', () => {
  const profile = {
    name: 'Profile',
    pid: 1,
    tid: 2,
    id: 'p',
    args: { data: { startTime: 100000 } },
  }
  const chunk = {
    name: 'ProfileChunk',
    pid: 1,
    tid: 99,
    id: 'p',
    ts: 100000,
    args: {
      data: {
        timeDeltas: [10000, 10000],
        cpuProfile: {
          nodes: [{ id: 1, callFrame: { functionName: 'get view' } }],
          samples: [1, 1],
        },
      },
    },
  }
  const result = sampledProfile(
    [profile, chunk, { ...chunk, pid: 3 }],
    { main: [{ name: 'compare/begin', pid: 1 }, profile], offset: 0 },
    {
      markers: [
        { operation: 'begin', time: 105 },
        { operation: 'end', time: 115 },
      ],
    },
  )
  assert.deepEqual(result, { 'get view': 10 })
})

test('frame cadence counts paced intervals and sums independent terminal callbacks', () => {
  const result = frameCadence(
    {
      markers: [
        { operation: 'paced-frame', detail: { timestamp: 0 } },
        { operation: 'paced-frame', detail: { timestamp: 16.67 } },
        { operation: 'paced-frame', detail: { timestamp: 50 } },
      ],
      spans: [
        { operation: 'drawFrame', start: 10, end: 12 },
        { operation: 'readRows', start: 10, end: 11 },
        { operation: 'drawFrame', start: 12, end: 15 },
      ],
    },
    {
      frames: [
        { start: 8, end: 17 },
        { start: 9, end: 16 },
      ],
    },
  )
  assert.equal(result.terminalWorkPerAnimationFrame.samples, 1)
  assert.equal(result.pacedIntervals.samples, 2)
  assert.equal(result.pacedIntervals.p95, 33.33)
  assert.equal(result.terminalWorkPerAnimationFrame.p50, 5)
})

test('presentation joins the containing animation frame identity, not a nearby global frame', () => {
  const clock = {
    offset: 100,
    frames: [{ start: 110, end: 130, id: 'matching-frame' }],
    main: [
      { name: 'AnimationFrame::Presentation', ts: 245000, args: { id: 'different-frame' } },
      { name: 'AnimationFrame::Presentation', ts: 250000, args: { id: 'matching-frame' } },
      { name: 'AnimationFrame::Render', ph: 'b', ts: 219000 },
    ],
  }
  const phase = {
    trace: 'sample.trace.json.gz',
    records: {
      timeOrigin: 1000,
      markers: [{ operation: 'echo-received', time: 109 }],
      spans: [
        { terminal: 0, category: 'parse', operation: 'parse', start: 110, end: 111, self: 1 },
        { terminal: 0, category: 'js', operation: 'drawFrame', start: 120, end: 125, self: 4 },
        { terminal: 0, category: 'commands', operation: 'submit', start: 124, end: 125, self: 1 },
      ],
    },
    sample: { captures: [{ operation: 'input', started: 1100, timestamp: 1140 }] },
  }
  const result = timelines(phase, clock)[0]
  assert.equal(result.echo, 9)
  assert.equal(result.parseEnd, 11)
  assert.equal(result.frame, 20)
  assert.equal(result.frameEnd, 25)
  assert.equal(result.chromePresented, 50)
  assert.equal(result.latency, 40)
  assert.equal(result.terminalWork, 6)
  assert.deepEqual(result.boundariesBeforeFrame, [19])
})

function completeArtifact() {
  const phases = ['ascii']
  const runs = [0, 1, 2].flatMap((repetition) =>
    ['ghostty-webgpu', 'xterm-webgl'].map((variant) => ({
      variant,
      count: 17,
      path: 'bytes',
      repetition,
      status: 'complete',
      phases: [false, true].map((traced) => ({
        label: `${variant}-17-${repetition}-ascii-${traced ? 'trace' : 'control'}`,
        traced,
        milliseconds: 100,
        cpu: { percentOfOneCore: 100 },
        records: traced ? {} : undefined,
        summary: traced ? {} : undefined,
        sample: { intervals: Array(180).fill(16.67) },
        trace: traced ? 'trace.json.gz' : undefined,
      })),
    })),
  )
  return {
    hardware: true,
    tracing: true,
    repetitions: 3,
    traceCounts: [17],
    tracePhases: phases,
    startedAt: '2026-10-01T00:00:00Z',
    finishedAt: '2026-10-01T00:01:00Z',
    environment: { os: 'darwin' },
    runs,
    qualifications: runs.flatMap((run) =>
      ['idle-display', 'mounted-workload', 'mounted-workload', 'mounted-workload'].map((kind) => ({
        variant: run.variant,
        count: run.count,
        repetition: run.repetition,
        kind,
        visibility: 'visible',
        frameCount: 120,
        periods: Array(120).fill(16.67),
        median: 16.67,
      })),
    ),
  }
}

test('qualified analysis rejects post-phase page errors and unfinished deadline evidence', () => {
  const valid = completeArtifact()
  assert.doesNotThrow(() => validateArtifact(valid))
  const failed = completeArtifact()
  failed.runs[0].error = 'late page error'
  failed.runs[0].pageErrors = ['page error']
  assert.throws(() => validateArtifact(failed), /Failed/)
  const partial = completeArtifact()
  delete partial.finishedAt
  partial.runs[0].status = 'running'
  partial.runs[0].phases.pop()
  assert.throws(() => validateArtifact(partial), /Incomplete/)
})

test('qualified analysis rejects a missing case or phase even with finishedAt', () => {
  const missing = completeArtifact()
  missing.runs.pop()
  assert.throws(() => validateArtifact(missing), /Incomplete/)
  const missingPhase = completeArtifact()
  missingPhase.runs[0].phases.pop()
  assert.throws(() => validateArtifact(missingPhase), /Incomplete/)
  const hidden = completeArtifact()
  hidden.qualifications[1].visibility = 'hidden'
  assert.throws(() => validateArtifact(hidden), /display unavailable/)
})
