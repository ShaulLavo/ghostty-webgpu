import { readFile, writeFile } from 'node:fs/promises'

export const commonBase = '46399e3f0a3ce5f5ce216eb6fdf474822851c720'
export const endpointNames = {
  host: 'CDP threadTicks TaskDuration',
  worker: 'Linux /proc DedicatedWorker utime+stime at 100 Hz',
  memory: 'Chrome-family PSS plus device VRAM growth',
} as const
export interface WorkerReading {
  target: string
  terminal: string
  ordinal: number
  renderer?: string | null
  backend?: string
  submitted: number | null
  heap: number | null
}
export interface Sample {
  mode: 'control' | 'candidate'
  fixture: string
  count: number
  columns: number
  rows: number
  repetition: number
  browserSession: string
  browser: string
  headless: boolean
  hardware?: HardwareEvidence
  executablePath?: string
  expectedProcesses: number[]
  renderer: string | null
  freeMiB: number | null
  warmup: number
  steps: number
  host: number | null
  workerCpu: number | null
  resident: number | null
  p95: number | null
  p99: number | null
  acknowledgementCount: number
  workers: WorkerReading[]
  workerThreads: { pid: number; tid: number; start: number; ticks: number }[]
  processes: { pid: number; pssKiB: number }[]
  submittedCounts: number[] | null
  parsedCounts: number[]
  deliveredFrames: number[]
  presentedCounts: null
  inputHashes: string[]
  inputBytes: number[]
  eventHashes: string[]
  rowHashes: string[]
  snapshotHashes: string[]
  screenshots: string[]
  frameSequences: string[][] | null
  errors: string[]
}
export interface ResearchReceipt {
  base: string
  candidate: string
  control: string
  scopeChecked: boolean
  wasmEqual: boolean
  headless: boolean
  parity: boolean
  repetitions: number
  warmup: number
  steps: number
  cohort: 'screen' | 'full'
  endpoints: typeof endpointNames
  results: Sample[]
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function vector(value: unknown, count: number): value is number[] {
  return Array.isArray(value) && value.length === count && Array.from(value).every(finite)
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}
function conditions(cohort: ResearchReceipt['cohort']) {
  const fixtures =
    cohort === 'full'
      ? ['sustained-logs', 'unicode-varied', 'mixed-edit']
      : ['sustained-logs', 'unicode-varied']
  return fixtures.flatMap((fixture) =>
    [4, 16].flatMap((count) =>
      [
        { columns: 200, rows: 50 },
        { columns: 80, rows: 24 },
      ].map((grid) => `${fixture}/${count}/${grid.columns}x${grid.rows}`),
    ),
  )
}
function key(run: Sample) {
  return `${run.fixture}/${run.count}/${run.columns}x${run.rows}`
}
function software(renderer: string | null) {
  return !renderer || /swiftshader|llvmpipe|software|lavapipe/iu.test(renderer)
}
function qualifyWorkers(run: Sample): boolean {
  if (!Array.isArray(run.workers) || run.workers.length !== run.count) return false
  if (!vector(run.submittedCounts, run.count)) return false
  const identities = new Set(run.workers.map((worker) => worker.terminal))
  const targets = new Set(run.workers.map((worker) => worker.target))
  if (identities.size !== run.count || targets.size !== run.count) return false
  return run.workers.every(
    (worker, ordinal) =>
      worker.ordinal === ordinal &&
      !!worker.terminal &&
      !!worker.target &&
      finite(worker.submitted) &&
      finite(worker.heap) &&
      (run.headless || (worker.backend === 'webgl2' && !software(worker.renderer ?? null))),
  )
}
function qualifyEndpoints(run: Sample): boolean {
  if (![run.host, run.workerCpu, run.resident, run.p95, run.p99].every(finite)) return false
  if (
    !qualifyWorkers(run) ||
    !Array.isArray(run.workerThreads) ||
    run.workerThreads.length !== run.count
  )
    return false
  if (
    new Set(run.workerThreads.map((thread) => `${thread.pid}/${thread.tid}/${thread.start}`))
      .size !== run.count
  )
    return false
  if (
    !run.workerThreads.every(
      (thread) =>
        [thread.pid, thread.tid, thread.start, thread.ticks].every(finite) &&
        thread.pid > 0 &&
        thread.tid > 0,
    )
  )
    return false
  if (
    !Array.isArray(run.processes) ||
    run.processes.length === 0 ||
    !Array.isArray(run.expectedProcesses)
  )
    return false
  if (
    !same(
      run.processes.map((process) => process.pid).toSorted((a, b) => a - b),
      run.expectedProcesses.toSorted((a, b) => a - b),
    )
  )
    return false
  return (
    run.processes.every(
      (process) =>
        finite(process.pid) && process.pid > 0 && finite(process.pssKiB) && process.pssKiB > 0,
    ) && new Set(run.processes.map((process) => process.pid)).size === run.processes.length
  )
}
function hardwareProblems(packet: ResearchReceipt): string[] {
  const problems: string[] = []
  if (
    packet.base !== commonBase ||
    packet.control !== commonBase ||
    !packet.candidate ||
    !packet.scopeChecked ||
    !packet.wasmEqual
  )
    problems.push('common-base/source qualification missing')
  if (packet.cohort !== 'screen' && packet.cohort !== 'full') problems.push('invalid cohort')
  if (!same(packet.endpoints, endpointNames)) problems.push('original PC endpoints missing')
  if (packet.repetitions !== 2 || packet.warmup !== 8 || packet.steps !== 60 || packet.parity)
    problems.push('fixed timing cohort counts missing')
  const expected = conditions(packet.cohort)
  if (packet.results.length !== expected.length * 4)
    problems.push('incomplete condition/repetition/arm matrix')
  for (const condition of expected) validatePairSet(packet, condition, problems)
  for (const run of packet.results) {
    if (!expected.includes(key(run))) problems.push('unexpected condition')
    if (run.headless || software(run.renderer) || !finite(run.freeMiB) || run.freeMiB < 2048)
      problems.push('headed hardware/VRAM proof missing')
    if (run.warmup !== 8 || run.steps !== 60 || run.acknowledgementCount !== 60)
      problems.push('sample steps missing')
    if (!qualifyEndpoints(run))
      problems.push('complete finite worker/CPU/PSS/submission endpoints missing')
    if (
      !run.hardware ||
      !Object.values(qualifyHardware(run.hardware)).every(Boolean) ||
      !run.executablePath
    )
      problems.push('actual launch/physical readback controls missing')
    if (!vector(run.parsedCounts, run.count) || !vector(run.deliveredFrames, run.count))
      problems.push('work counts missing')
    if (run.parsedCounts?.some((count, index) => count !== (index === 0 ? 60 : 15)))
      problems.push('prescribed parsed work counts missing')
  }
  return Array.from(new Set(problems))
}
function validatePairSet(packet: ResearchReceipt, condition: string, problems: string[]): void {
  for (const repetition of [0, 1]) {
    const pair = packet.results.filter(
      (run) => key(run) === condition && run.repetition === repetition,
    )
    const order = repetition === 0 ? ['control', 'candidate'] : ['candidate', 'control']
    if (
      !same(
        pair.map((run) => run.mode),
        order,
      ) ||
      !pair[0]?.browserSession ||
      pair[0].browserSession !== pair[1]?.browserSession ||
      pair[0].browser !== pair[1]?.browser
    )
      problems.push('counterbalanced same-browser pair missing')
  }
}
const parityKeys = [
  'inputHashes',
  'inputBytes',
  'eventHashes',
  'rowHashes',
  'snapshotHashes',
  'screenshots',
  'parsedCounts',
  'deliveredFrames',
  'frameSequences',
] as const
function correctnessProblems(packet: ResearchReceipt): string[] {
  const problems: string[] = []
  for (const run of packet.results) {
    if (!Array.isArray(run.errors) || run.errors.length !== 0) problems.push('runtime errors')
    for (const field of parityKeys.filter((field) => field !== 'frameSequences')) {
      if (!Array.isArray(run[field]) || run[field].length !== run.count)
        problems.push(`missing ${field}`)
    }
    const peer = packet.results.find(
      (other) =>
        key(run) === key(other) && run.repetition === other.repetition && other.mode !== run.mode,
    )
    if (!peer) {
      problems.push('missing comparison arm')
      continue
    }
    for (const field of parityKeys)
      if (!same(run[field], peer[field])) problems.push(`${key(run)} ${field} mismatch`)
    if (packet.parity && (!run.frameSequences || run.frameSequences.length !== run.count))
      problems.push('per-frame parity missing')
  }
  return Array.from(new Set(problems))
}
function numericConditions(packet: ResearchReceipt) {
  return conditions(packet.cohort).map((condition) => {
    const runs = packet.results.filter((run) => key(run) === condition)
    const ratio = (field: 'host' | 'workerCpu' | 'resident' | 'p95' | 'p99') => {
      const sum = (mode: Sample['mode']) =>
        runs.filter((run) => run.mode === mode).reduce((total, run) => total + run[field]!, 0) / 2
      return sum('candidate') / sum('control')
    }
    const ratios = {
      host: ratio('host'),
      worker: ratio('workerCpu'),
      memory: ratio('resident'),
      p95: ratio('p95'),
      p99: ratio('p99'),
    }
    const gates = {
      host: ratios.host <= 0.5,
      worker: ratios.worker <= 1,
      memory: ratios.memory <= 1,
      p95: ratios.p95 <= 1.2,
      p99: ratios.p99 <= 1.2,
    }
    return { condition, ratios, gates }
  })
}
export function analyze(packet: ResearchReceipt) {
  const correctness = correctnessProblems(packet)
  const qualification = hardwareProblems(packet)
  const counts = {
    submittedDifferences: packet.results
      .filter((run) => run.mode === 'candidate')
      .filter(
        (run) =>
          !same(
            run.submittedCounts,
            packet.results.find(
              (peer) =>
                key(run) === key(peer) &&
                run.repetition === peer.repetition &&
                peer.mode === 'control',
            )?.submittedCounts,
          ),
      )
      .map(key),
    presented: 'unresolved',
  }
  if (packet.headless)
    return { decision: 'correctness-only', correctness, qualification, conditions: [], counts }
  if (qualification.length)
    return { decision: 'unqualified', correctness, qualification, conditions: [], counts }
  const results = numericConditions(packet)
  const pass =
    !correctness.length && results.every((result) => Object.values(result.gates).every(Boolean))
  return {
    decision: pass ? 'KEEP' : 'REJECT',
    correctness,
    qualification,
    conditions: results,
    counts,
  }
}

if (import.meta.main) {
  const packet: ResearchReceipt = JSON.parse(await readFile(process.argv[2]!, 'utf8'))
  const result = analyze(packet)
  await writeFile(process.argv[3]!, JSON.stringify(result, null, 2) + '\n')
  console.log(result.decision)
}

type GlEvidence =
  | { available: false }
  | {
      available: true
      unmaskedRenderer: string | null
      positiveControl: boolean
      error: number
    }
type GpuEvidence =
  | { available: false }
  | {
      available: true
      identity: { vendor: string; isFallbackAdapter: boolean }
      positiveControl: boolean
      validation: string | null
      errors: readonly string[]
    }
export type HardwareEvidence = {
  headless: boolean
  commandLine: { arguments: readonly string[] }
  system: {
    gpu: {
      devices: readonly {
        vendorId: number
        deviceId: number
        driverVendor: string
        driverVersion: string
        deviceString: string
      }[]
    }
  }
  result: { webgl: GlEvidence; webgl2: GlEvidence; webgpu: GpuEvidence }
}
const softwareLabel = /swiftshader|llvmpipe|lavapipe|software rasterizer/i

export function qualifyHardware(evidence: HardwareEvidence) {
  const headed =
    !evidence.headless &&
    !evidence.commandLine.arguments.some((arg) => arg.startsWith('--headless'))
  const adapter = evidence.system.gpu.devices[0]
  const physical =
    headed &&
    !!adapter &&
    adapter.vendorId === 0x10de &&
    adapter.deviceId === 0x2489 &&
    /nvidia/i.test(adapter.driverVendor) &&
    !!adapter.driverVersion &&
    !softwareLabel.test(adapter.deviceString)
  function glQualified(gl: GlEvidence) {
    return (
      physical &&
      gl.available &&
      gl.positiveControl &&
      gl.error === 0 &&
      typeof gl.unmaskedRenderer === 'string' &&
      /NVIDIA.*RTX 3060 Ti/i.test(gl.unmaskedRenderer) &&
      !softwareLabel.test(gl.unmaskedRenderer)
    )
  }
  const gpu = evidence.result.webgpu
  const webgpu =
    physical &&
    gpu.available &&
    gpu.identity.vendor.toLowerCase() === 'nvidia' &&
    !gpu.identity.isFallbackAdapter &&
    gpu.positiveControl &&
    gpu.validation === null &&
    gpu.errors.length === 0
  return {
    headed,
    physicalNvidia: physical,
    webgl: glQualified(evidence.result.webgl),
    webgl2: glQualified(evidence.result.webgl2),
    webgpu,
  }
}
