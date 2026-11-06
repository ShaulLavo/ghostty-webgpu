import { expect, it } from 'vitest'
import {
  analyze,
  commonBase,
  endpointNames,
  type ResearchReceipt,
  type Sample,
} from './worker-revision-summary.js'

function receipt(): ResearchReceipt {
  const results: Sample[] = []
  for (const repetition of [0, 1]) addRepetition(repetition, results)
  return {
    base: commonBase,
    candidate: 'candidate-head',
    control: commonBase,
    scopeChecked: true,
    wasmEqual: true,
    headless: false,
    parity: false,
    cohort: 'screen',
    warmup: 8,
    steps: 60,
    repetitions: 2,
    endpoints: endpointNames,
    results,
  }
}
function addRepetition(repetition: number, results: Sample[]) {
  const cases = ['sustained-logs', 'unicode-varied'].flatMap((fixture) =>
    [4, 16].flatMap((count) =>
      [
        [200, 50],
        [80, 24],
      ].map(([columns, rows]) => ({ fixture, count, columns: columns!, rows: rows! })),
    ),
  )
  for (const condition of cases) {
    const order: Sample['mode'][] =
      repetition === 0 ? ['control', 'candidate'] : ['candidate', 'control']
    for (const mode of order) results.push(sample(mode, repetition, condition))
  }
}
function sample(
  mode: Sample['mode'],
  repetition: number,
  condition: Pick<Sample, 'fixture' | 'count' | 'columns' | 'rows'>,
): Sample {
  const { count } = condition
  const numbers = Array.from({ length: count }, (_, index) => (index === 0 ? 60 : 15))
  const strings = Array.from({ length: count }, () => 'hash')
  return {
    ...condition,
    mode,
    repetition,
    browserSession: `${condition.fixture}/${count}/${condition.columns}/${repetition}`,
    browser: 'chromium-test',
    headless: false,
    renderer: 'ANGLE NVIDIA RTX 3060 Ti',
    executablePath: '/usr/bin/chromium',
    expectedProcesses: [1],
    hardware: {
      headless: false,
      commandLine: { arguments: ['--enable-automation'] },
      system: {
        gpu: {
          devices: [
            {
              vendorId: 0x10de,
              deviceId: 0x2489,
              driverVendor: 'NVIDIA',
              driverVersion: '615',
              deviceString: 'NVIDIA RTX 3060 Ti',
            },
          ],
        },
      },
      result: {
        webgl: {
          available: true,
          unmaskedRenderer: 'NVIDIA RTX 3060 Ti',
          positiveControl: true,
          error: 0,
        },
        webgl2: {
          available: true,
          unmaskedRenderer: 'NVIDIA RTX 3060 Ti',
          positiveControl: true,
          error: 0,
        },
        webgpu: {
          available: true,
          identity: { vendor: 'nvidia', isFallbackAdapter: false },
          positiveControl: true,
          validation: null,
          errors: [],
        },
      },
    },
    freeMiB: 7000,
    warmup: 8,
    steps: 60,
    host: mode === 'control' ? 2 : 0.8,
    workerCpu: 1,
    resident: 100,
    p95: 10,
    p99: 20,
    acknowledgementCount: 60,
    workers: numbers.map((_, ordinal) => ({
      target: `target-${ordinal}`,
      terminal: `terminal-${ordinal}`,
      ordinal,
      submitted: 60,
      heap: 100,
    })),
    workerThreads: numbers.map((_, tid) => ({ pid: 1, tid: tid + 1, start: 100, ticks: 10 })),
    processes: [{ pid: 1, pssKiB: 1000 }],
    submittedCounts: numbers.slice(),
    parsedCounts: numbers,
    deliveredFrames: numbers,
    presentedCounts: null,
    inputHashes: strings,
    inputBytes: numbers,
    eventHashes: strings,
    rowHashes: strings,
    snapshotHashes: strings,
    screenshots: strings,
    frameSequences: null,
    errors: [],
  }
}

it('keeps a fully qualified screen and rejects each original numerical gate without tolerances', () => {
  expect(analyze(receipt()).decision).toBe('KEEP')
  for (const field of ['host', 'workerCpu', 'resident', 'p95', 'p99'] as const) {
    const packet = receipt()
    packet.results.find((run) => run.mode === 'candidate')![field] = 10000
    expect(analyze(packet).decision).toBe('REJECT')
  }
})
it('never promotes excellent headless smoke ratios to hardware acceptance', () => {
  const packet = receipt()
  packet.headless = true
  expect(analyze(packet).decision).toBe('correctness-only')
})
it.each([
  'condition',
  'repetition',
  'steps',
  'workers',
  'submissions',
  'cpu',
  'pss',
  'software',
  'thread',
  'order',
  'base',
])('fails qualification closed for missing %s', (failure) => {
  const packet = receipt()
  const first = packet.results[0]!
  if (failure === 'condition')
    packet.results = packet.results.filter((run) => run.fixture !== 'sustained-logs')
  if (failure === 'repetition')
    packet.results = packet.results.filter((run) => run.repetition === 0)
  if (failure === 'steps') {
    packet.steps = 4
    first.steps = 4
  }
  if (failure === 'workers') first.workers.pop()
  if (failure === 'submissions') first.submittedCounts = null
  if (failure === 'cpu') first.workerCpu = null
  if (failure === 'pss') first.processes = []
  if (failure === 'software') first.renderer = 'SwiftShader'
  if (failure === 'thread') first.workerThreads.pop()
  if (failure === 'order') packet.results.reverse()
  if (failure === 'base') packet.control = 'old-main'
  expect(analyze(packet).decision).toBe('unqualified')
})
it('reports independent submission differences without adding a submission equality gate', () => {
  const packet = receipt()
  packet.results.find((run) => run.mode === 'candidate')!.submittedCounts![0] = 59
  expect(analyze(packet).decision).toBe('KEEP')
  expect(analyze(packet).counts.submittedDifferences).not.toHaveLength(0)
})
it('requires complete public payload, input, event, acknowledgement and delivery parity', () => {
  const packet = receipt()
  packet.results[0]!.snapshotHashes = ['different']
  expect(analyze(packet).decision).toBe('REJECT')
})
