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

test('compact evidence preserves GPU qualifications without display periods', () => {
  const gpu = {
    kind: 'idle',
    status: 'qualified',
    qualified: true,
    samples: [{ utilizationPercent: 0, computeMemoryMiB: 0 }],
    settings: { gpuIdleConsecutiveSamples: 3 },
  }
  const result = compactAnalysis({
    qualifications: [gpu, { median: 16.67, periods: [16.67] }],
    rows: [],
  })
  assert.deepEqual(result.qualifications[0], gpu)
  assert.match(result.qualifications[1].periodsSha256, /^[a-f0-9]{64}$/)
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
        timeDeltas: [0, 20000],
        cpuProfile: {
          nodes: [{ id: 1, callFrame: { functionName: 'get view' } }],
          samples: [1, 1],
        },
      },
    },
  }
  const result = sampledProfile(
    [profile, chunk, { ...chunk, pid: 3 }],
    {
      main: [
        { name: 'compare/begin', pid: 1 },
        profile,
        { name: 'RunTask', ph: 'X', ts: 100000, dur: 30000 },
      ],
      offset: 0,
    },
    {
      markers: [
        { operation: 'begin', time: 105 },
        { operation: 'end', time: 115 },
      ],
    },
  )
  assert.deepEqual(result, { 'get view': 10 })
})

test('backwards CPU sample deltas partition merged main tasks without overlapping attribution', () => {
  const profile = { name: 'Profile', pid: 1, id: 'p', args: { data: { startTime: 0 } } }
  const chunks = [
    {
      name: 'ProfileChunk',
      pid: 1,
      id: 'p',
      ts: 0,
      args: {
        data: {
          timeDeltas: [0, 8000, -4000],
          cpuProfile: {
            nodes: [
              { id: 1, callFrame: { functionName: 'parse' } },
              { id: 3, callFrame: { functionName: 'copy' } },
            ],
            samples: [1, 2, 3],
          },
        },
      },
    },
    {
      name: 'ProfileChunk',
      pid: 1,
      id: 'p',
      ts: 12000,
      args: {
        data: {
          timeDeltas: [8000],
          cpuProfile: {
            nodes: [
              { id: 2, callFrame: { functionName: 'render' } },
              { id: 4, callFrame: { functionName: 'last' } },
            ],
            samples: [4],
          },
        },
      },
    },
  ]
  const main = [
    { name: 'compare/begin', pid: 1 },
    profile,
    { name: 'RunTask', ph: 'X', ts: 1000, dur: 6000 },
    { name: 'RunTask', ph: 'X', ts: 3000, dur: 2000 },
    { name: 'RunTask', ph: 'X', ts: 9000, dur: 2000 },
  ]
  const result = sampledProfile(
    [profile, ...chunks],
    { main, offset: 0 },
    {
      markers: [
        { operation: 'begin', time: 1 },
        { operation: 'end', time: 11 },
      ],
    },
  )
  assert.deepEqual(result, { parse: 3, copy: 3, render: 2 })
  assert.equal(
    Object.values(result).reduce((sum, value) => sum + value, 0),
    8,
  )
})

test('CPU profile leaves preserve unsampled edges and resolve equal timestamps without phantom tails', () => {
  const profile = { name: 'Profile', pid: 1, id: 'p', args: { data: { startTime: 100000 } } }
  const chunk = {
    name: 'ProfileChunk',
    pid: 1,
    id: 'p',
    ts: 100000,
    args: {
      data: {
        timeDeltas: [2000, 0, 4000],
        cpuProfile: {
          nodes: [
            { id: 1, callFrame: { functionName: 'first' } },
            { id: 2, callFrame: { functionName: 'second' } },
            { id: 3, callFrame: { functionName: 'last' } },
          ],
          samples: [1, 2, 3],
        },
      },
    },
  }
  const result = sampledProfile(
    [profile, chunk],
    {
      main: [
        { name: 'compare/begin', pid: 1 },
        profile,
        { name: 'RunTask', ph: 'X', ts: 99000, dur: 11000 },
      ],
      offset: 100,
    },
    {
      markers: [
        { operation: 'begin', time: 0 },
        { operation: 'end', time: 10 },
      ],
    },
  )
  assert.deepEqual(result, { '(unsampled)': 6, second: 4 })
  assert.equal(
    Object.values(result).reduce((sum, value) => sum + value, 0),
    10,
  )
})

test('CPU leaf names inherited from Object.prototype remain numeric and preserve coverage', () => {
  const profile = { name: 'Profile', pid: 1, id: 'p', args: { data: { startTime: 0 } } }
  const names = ['constructor', 'toString', '__proto__']
  const chunk = {
    name: 'ProfileChunk',
    pid: 1,
    id: 'p',
    ts: 0,
    args: {
      data: {
        timeDeltas: [0, 1000, 1000, 1000],
        cpuProfile: {
          nodes: names.map((functionName, index) => ({
            id: index + 1,
            callFrame: { functionName },
          })),
          samples: [1, 2, 3, 1],
        },
      },
    },
  }
  const result = sampledProfile(
    [profile, chunk],
    {
      main: [
        { name: 'compare/begin', pid: 1 },
        profile,
        { name: 'RunTask', ph: 'X', ts: 0, dur: 4000 },
      ],
      offset: 0,
    },
    {
      markers: [
        { operation: 'begin', time: 0 },
        { operation: 'end', time: 4 },
      ],
    },
  )
  for (const name of names) {
    assert.equal(Object.hasOwn(result, name), true)
    assert.equal(result[name], 1)
  }
  assert.equal(result['(unsampled)'], 1)
  assert.equal(
    Object.values(result).reduce((sum, value) => sum + value, 0),
    4,
  )
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

function completeArtifact(phaseName = 'ascii') {
  const phases = [phaseName]
  const runs = [0, 1, 2].flatMap((repetition) =>
    ['ghostty-webgpu', 'xterm-webgl'].map((variant) => ({
      variant,
      count: 17,
      path: 'bytes',
      repetition,
      status: 'complete',
      phases: [false, true].map((traced) => ({
        label: `${variant}-17-${repetition}-${phaseName}-${traced ? 'trace' : 'control'}`,
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
    variants: ['ghostty-webgpu', 'xterm-webgl'],
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

test('qualified analysis accepts both rolling fixtures and rejects a missing control phase', () => {
  for (const phase of ['rolling-logs', 'rolling-unicode-logs', 'rolling-slow']) {
    const artifact = completeArtifact(phase)
    assert.doesNotThrow(() => validateArtifact(artifact))
    artifact.runs[0].phases.shift()
    assert.throws(() => validateArtifact(artifact), /Incomplete phase pairs/)
  }
})

test('qualified analysis rejects unknown and duplicate rolling phase selections', () => {
  assert.throws(() => validateArtifact(completeArtifact('unknown')), /Incomplete phase matrix/)
  const duplicate = completeArtifact('rolling-logs')
  duplicate.tracePhases.push('rolling-logs')
  assert.throws(() => validateArtifact(duplicate), /Incomplete phase matrix/)
})

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
function pairedFrameArtifact() {
  const artifact = completeArtifact()
  artifact.frameBuilders = ['js', 'zig']
  artifact.runs = artifact.runs.flatMap((run) => {
    if (run.variant !== 'ghostty-webgpu') return [run]
    return ['js', 'zig'].map((frameBuilder) => ({
      ...run,
      frameBuilder,
      phases: run.phases.map((phase) => ({
        ...phase,
        label: phase.label.replace(run.variant, `${run.variant}-${frameBuilder}`),
      })),
    }))
  })
  artifact.qualifications = artifact.qualifications.flatMap((probe) => {
    if (probe.variant !== 'ghostty-webgpu') return [probe]
    return ['js', 'zig'].map((frameBuilder) => ({ ...probe, frameBuilder }))
  })
  return artifact
}

test('trace validation distinguishes complete JS and Zig treatments beside one xterm control', () => {
  assert.doesNotThrow(() => validateArtifact(pairedFrameArtifact()))
  const missing = pairedFrameArtifact()
  missing.runs.pop()
  assert.throws(() => validateArtifact(missing), /Incomplete case matrix/)
  const duplicate = pairedFrameArtifact()
  duplicate.runs[1] = structuredClone(duplicate.runs[0])
  assert.throws(() => validateArtifact(duplicate), /duplicate case matrix/)
})

test('paired trace validation rejects unknown treatments and cross-treatment qualification', () => {
  const unknown = pairedFrameArtifact()
  unknown.runs[0].frameBuilder = 'unknown'
  assert.throws(() => validateArtifact(unknown), /unexpected case/)
  const wrongControl = pairedFrameArtifact()
  wrongControl.runs.find((run) => run.variant === 'xterm-webgl').frameBuilder = 'js'
  assert.throws(() => validateArtifact(wrongControl), /unexpected case/)
  const mismatched = pairedFrameArtifact()
  mismatched.qualifications[0].frameBuilder = 'zig'
  assert.throws(() => validateArtifact(mismatched), /Incomplete display evidence/)
})

test('attribution and latency choose the same painted frame after a deferred no-op', () => {
  const clock = {
    offset: 0,
    frames: [
      { start: 10, end: 15, id: 'noop' },
      { start: 20, end: 30, id: 'painted' },
    ],
    main: [
      { name: 'AnimationFrame::Presentation', ts: 16000, args: { id: 'noop' } },
      { name: 'AnimationFrame::Presentation', ts: 31000, args: { id: 'painted' } },
    ],
  }
  for (const [backend, operation, render] of [
    ['canvas2d', 'paint', 'drawFrame'],
    ['ghostty-web', 'renderLine', 'render'],
    ['xterm-dom', 'replaceChildren', 'renderRows'],
  ]) {
    const phase = {
      records: {
        timeOrigin: 1000,
        markers: [],
        ownership: [{ terminal: 0, backend }],
        spans: [
          { terminal: 0, category: 'parse', operation: 'parse', start: 1, end: 2, self: 1 },
          { terminal: 0, category: 'js', operation: render, start: 11, end: 14, self: 3 },
          { terminal: 0, category: 'js', operation: render, start: 21, end: 29, self: 6 },
          { terminal: 0, category: 'commands', operation, start: 25, end: 27, self: 2 },
        ],
      },
      sample: { captures: [{ operation: 'write', started: 1000, timestamp: 1040 }] },
    }
    const result = timelines(phase, clock)[0]
    assert.equal(result.animationId, 'painted')
    assert.equal(result.frame, 21)
    assert.equal(result.renderBoundary, operation)
    assert.equal(result.renderBoundaryEnd, 27)
    phase.records.spans.pop()
    assert.throws(() => timelines(phase, clock), /committed row paint/)
  }
})

function selectedArtifact(variants, builders = ['zig']) {
  const artifact = completeArtifact()
  const templates = structuredClone(artifact.runs.filter((run) => run.variant === 'ghostty-webgpu'))
  const probes = structuredClone(
    artifact.qualifications.filter((probe) => probe.variant === 'ghostty-webgpu'),
  )
  artifact.variants = variants
  artifact.frameBuilders = builders
  const treatments = variants.flatMap((variant) =>
    ['ghostty-webgpu', 'ghostty-webgl'].includes(variant)
      ? builders.map((frameBuilder) => ({ variant, frameBuilder }))
      : [{ variant }],
  )
  artifact.runs = treatments.flatMap((treatment) =>
    templates.map((run) => ({
      ...run,
      ...treatment,
      phases: run.phases.map((phase) => ({
        ...phase,
        label: phase.label.replace(
          run.variant,
          treatment.frameBuilder
            ? `${treatment.variant}-${treatment.frameBuilder}`
            : treatment.variant,
        ),
      })),
    })),
  )
  artifact.qualifications = treatments.flatMap((treatment) =>
    probes.map((probe) => ({ ...probe, ...treatment })),
  )
  return artifact
}

test('trace selected subsets and expanded native renderer matrix retain exact slots', () => {
  for (const variants of [
    ['ghostty-canvas', 'ghostty-web'],
    ['ghostty-webgl', 'xterm-webgl', 'ghostty-dom', 'xterm-dom', 'ghostty-canvas', 'ghostty-web'],
  ]) {
    const artifact = selectedArtifact(variants)
    artifact.frameBuilders = ['zig']
    assert.doesNotThrow(() => validateArtifact(artifact))
    const missing = structuredClone(artifact)
    missing.runs.pop()
    assert.throws(() => validateArtifact(missing), /Incomplete case matrix/)
    const duplicate = structuredClone(artifact)
    duplicate.runs[1] = structuredClone(duplicate.runs[0])
    assert.throws(() => validateArtifact(duplicate), /duplicate case matrix/)
    artifact.runs[0].frameBuilder = 'js'
    assert.throws(() => validateArtifact(artifact), /unexpected case/)
  }
  const unknown = selectedArtifact(['unknown'])
  assert.throws(() => validateArtifact(unknown), /unknown variant matrix/)
})

test('single selected WebGPU builder requires its own labelled treatment and qualification', () => {
  const artifact = pairedFrameArtifact()
  artifact.frameBuilders = ['zig']
  artifact.runs = artifact.runs.filter((run) => run.frameBuilder !== 'js')
  artifact.qualifications = artifact.qualifications.filter((probe) => probe.frameBuilder !== 'js')
  assert.doesNotThrow(() => validateArtifact(artifact))
  artifact.qualifications[0].frameBuilder = 'js'
  assert.throws(() => validateArtifact(artifact), /Incomplete display evidence/)
})

test('trace validation qualifies both GPU builders with exact treatment labels', () => {
  const artifact = selectedArtifact(
    ['ghostty-webgpu', 'ghostty-webgl', 'xterm-webgl'],
    ['js', 'zig'],
  )
  assert.doesNotThrow(() => validateArtifact(artifact))
  const mismatched = structuredClone(artifact)
  mismatched.qualifications.find((probe) => probe.variant === 'ghostty-webgl').frameBuilder = 'zig'
  assert.throws(() => validateArtifact(mismatched), /Incomplete display evidence/)
  const unlabeled = structuredClone(artifact)
  delete unlabeled.runs.find((run) => run.variant === 'ghostty-webgl').frameBuilder
  assert.throws(() => validateArtifact(unlabeled), /unexpected case/)
})
